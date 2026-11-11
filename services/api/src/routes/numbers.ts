import { DestinationSchema, billingPeriod, withRetry, type Destination, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { proratedCents } from '../billing/catalog.js';
import type { StripeClient } from '../billing/stripe.js';
import { HttpError } from '../errors.js';
import type { DidProvider } from '../numbers/provider.js';
import { numberPriceCents, purchaseNumber } from '../numbers/purchase.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { IdParams, assertOwned, destinationRefs, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';

// Phone numbers (DIDs): search, buy, list, route, release (backend steps 5 and 8;
// docs/backend-step8.md, purchase flow in src/numbers/purchase.ts).
//
// GET    /numbers                          any user   200 [number]          the account's numbers
// GET    /numbers/:id                      any user   200 number            404
// GET    /numbers/countries                owner      200 [country]
// GET    /numbers/regions?country          owner      200 [place]
// GET    /numbers/cities?country&regionId  owner      200 [place]
// GET    /numbers/available?country&regionId&cityId&areaCode&kind&limit
//                                          owner      200 [offer]           with our price and what is due now
// POST   /numbers/purchase { availableNumberId }  + Idempotency-Key header
//                                          owner      201 { number, chargedCents, replayed }
//                                                     202 still processing (retry with the same key)
//                                                     400, 402, 409, 502
// PUT    /numbers/:id/route { destination }  owner    200 number            400, 404 (also after release, until paidUntil)
// DELETE /numbers/:id                      owner      200 number (released) 404, 502
//
// number = { id, did, status, kind, destination, paidUntil, purchasedAt }
// A released number keeps routing until paidUntil (paid period end), then lapses at the provider
// too (it is not renewed). It no longer shows in the list after that.

// One schema (not a union): a malformed `destination` must be a 400, never fall through to the
// legacy branch and silently unroute the number. Both omitted = unroute.
const RouteBody = z
  .object({
    destination: DestinationSchema.nullable().optional().describe('Where calls go; null = unroute (calls are hung up).'),
    ivrMenuId: z.string().uuid().nullable().optional().describe('Deprecated (phase 1): same as destination {type: "ivr_menu", id}. Ignored when destination is sent.'),
  })
  .transform(({ destination, ivrMenuId }) => ({
    destination:
      destination !== undefined
        ? destination
        : ivrMenuId
          ? ({ type: 'ivr_menu', id: ivrMenuId } as const)
          : null,
  }));

const KINDS = ['local', 'toll_free'] as const;
const country = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'must be a 2-letter ISO country code')
  .transform((s) => s.toUpperCase())
  .default('US')
  .describe('ISO 3166 country code, e.g. "US" (default).');

const RegionsQuery = z.object({ country });
const CitiesQuery = z.object({
  country,
  regionId: z.string().max(100).optional().describe('Only cities in this region (`id` from GET /numbers/regions).'),
});
const AvailableQuery = z.object({
  country,
  regionId: z.string().max(100).optional().describe('Region id from GET /numbers/regions.'),
  cityId: z.string().max(100).optional().describe('City id from GET /numbers/cities.'),
  areaCode: z.string().regex(/^[0-9]{1,6}$/, 'must be digits').optional().describe('Area code, e.g. "201".'),
  kind: z.enum(KINDS).optional().describe('local or toll_free. Omitted = both.'),
  limit: z.coerce.number().int().min(1).max(50).default(20).describe('How many numbers to return, 1-50 (default 20).'),
});

const PurchaseBody = z
  .object({
    availableNumberId: z.string().min(1).max(200).describe('`id` of a number from GET /numbers/available.'),
  })
  .strict()
  .describe('The number to buy.');

/** Idempotency-Key: any client-chosen string, e.g. a UUID per purchase attempt. */
const IdempotencyKey = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .regex(/^[A-Za-z0-9_.:-]{1,200}$/, 'Idempotency-Key must be 1-200 letters, digits or _.:-');

interface PhoneNumber {
  id: string;
  did: string;
  status: 'assigned' | 'released';
  kind: 'local' | 'toll_free';
  destination: Destination | null;
  paidUntil: Date | null;
  purchasedAt: Date;
}

const NumberSchema = z
  .object({
    id: z.string().uuid().describe('Phone number id.'),
    did: z.string().describe('The number, E.164.'),
    status: z.enum(['assigned', 'released']).describe('released numbers keep working until paidUntil, then lapse.'),
    kind: z.enum(KINDS).describe('Number type.'),
    destination: DestinationSchema.nullable().describe('Where calls to the number go; null = not routed (hang up).'),
    paidUntil: z.string().datetime().nullable().describe('End of the period the number is paid for.'),
    purchasedAt: z.string().datetime().describe('When it was bought.'),
  })
  .describe("One of the account's phone numbers.");

const PlaceSchema = z
  .object({ id: z.string().describe('Provider id; pass it as regionId / cityId.'), name: z.string().describe('Display name.') })
  .describe('A region or city.');

const OfferSchema = z
  .object({
    id: z.string().describe('Offer id: send it to POST /numbers/purchase as availableNumberId.'),
    number: z.string().describe('The number, E.164.'),
    kind: z.enum(KINDS).describe('local or toll_free.'),
    country: z.string().describe('ISO country code.'),
    region: z.string().nullable().describe('Region name, if known.'),
    city: z.string().nullable().describe('City name, if known.'),
    areaCode: z.string().nullable().describe('Area code, if known.'),
    priceCents: z.number().int().describe('Price per 7-day billing period, US cents.'),
    dueNowCents: z
      .number()
      .int()
      .describe('Charged now if bought: the price prorated to the end of the current billing period (0 below the minimum charge).'),
  })
  .describe('A number that can be bought.');

const PurchaseResultSchema = z
  .object({
    number: NumberSchema,
    chargedCents: z.number().int().describe('Charged to the saved card for this purchase, US cents.'),
    replayed: z.boolean().describe('true = this Idempotency-Key was already completed; nothing new was bought or charged.'),
  })
  .describe('The bought number.');

const ProcessingSchema = z
  .object({
    status: z.literal('processing').describe('The provider is still processing the order.'),
    message: z.string().describe('What to do: repeat the same request with the same Idempotency-Key.'),
  })
  .describe('Purchase still in progress.');

const notFound = () => new HttpError(404, 'not_found', 'No such phone number');
const OWNER_SEARCH = 'Account owner searches before buying.';

const docs = {
  list: {
    tag: 'Numbers',
    auth: 'user',
    summary: "List the account's numbers",
    description: 'Active numbers, plus released ones until their paid period ends. Sorted by number.',
    responses: { 200: { description: 'The numbers', schema: z.array(NumberSchema).describe('The numbers.') } },
  },
  get: {
    tag: 'Numbers',
    auth: 'user',
    summary: 'Get a number',
    params: IdParams,
    responses: { 200: { description: 'The number', schema: NumberSchema } },
    errors: { 404: 'No such number in this account (`not_found`).' },
  },
  countries: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Countries with numbers',
    description: OWNER_SEARCH,
    responses: {
      200: {
        description: 'Countries',
        schema: z
          .array(
            z
              .object({
                iso: z.string().describe('ISO country code (the `country` parameter).'),
                name: z.string().describe('Country name.'),
                prefix: z.string().describe('Calling code without "+".'),
              })
              .describe('A country.'),
          )
          .describe('Countries, by name.'),
      },
    },
    errors: { 502: 'The number provider failed (`did_provider_error`); retry.' },
  },
  regions: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Regions of a country',
    description: OWNER_SEARCH,
    query: RegionsQuery,
    responses: { 200: { description: 'Regions', schema: z.array(PlaceSchema).describe('Regions, by name.') } },
    errors: { 502: 'The number provider failed (`did_provider_error`); retry.' },
  },
  cities: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Cities of a country or region',
    description: OWNER_SEARCH,
    query: CitiesQuery,
    responses: { 200: { description: 'Cities', schema: z.array(PlaceSchema).describe('Cities, by name.') } },
    errors: { 502: 'The number provider failed (`did_provider_error`); retry.' },
  },
  available: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Search numbers to buy',
    description:
      'Numbers the provider has in stock, by country, region or city, area code and type, with our price and the ' +
      'prorated amount that would be charged now.',
    query: AvailableQuery,
    responses: { 200: { description: 'Offers', schema: z.array(OfferSchema).describe('Numbers that can be bought.') } },
    errors: { 502: 'The number provider failed (`did_provider_error`); retry.' },
  },
  purchase: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Buy a number',
    description:
      'Orders the number at the provider, routes it to this PBX, then charges the saved card its price prorated to the ' +
      'end of the current billing period, and adds it to the account (route it with PUT /numbers/{id}/route). ' +
      'If the card is declined the number is not kept. **Idempotent:** send a unique Idempotency-Key per purchase; ' +
      'repeating the request with the same key never buys or charges twice. It returns the first result, finishes an ' +
      'interrupted purchase, or (202) is still processing.',
    headers: { 'Idempotency-Key': { description: 'Unique per purchase (e.g. a UUID), 1-200 of A-Z a-z 0-9 _ . : -. Reuse it to retry.', required: true } },
    body: PurchaseBody,
    responses: {
      201: { description: 'Bought (or replayed)', schema: PurchaseResultSchema },
      202: { description: 'Still processing at the provider; repeat with the same Idempotency-Key', schema: ProcessingSchema, headers: { 'Retry-After': 'Seconds to wait before repeating.' } },
    },
    errors: {
      402: 'No saved card / plan not paid / account past due (`payment_required`), or the card was declined (`payment_failed`; nothing was bought).',
      409:
        'The number was taken meanwhile (`number_unavailable`), this key was used for a different number ' +
        '(`idempotency_key_reused`), or another request with this key is running (`purchase_in_progress`).',
      502: 'The number provider (`did_provider_error`) or the payment service (`payment_gateway_error`) failed. Retry with the same Idempotency-Key.',
    },
  },
  route: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Route a phone number',
    description:
      'Sets where calls to the number go: an extension, ring group, IVR menu or business hours schedule ' +
      '(voicemail, external and hangup work too). A released number can be re-routed until `paidUntil`. ' +
      'The phase-1 body `{ "ivrMenuId" }` is still accepted.',
    params: IdParams,
    body: RouteBody,
    responses: { 200: { description: 'The routed number', schema: NumberSchema } },
    errors: { 404: 'No such number in this account, or it was released and its paid period has ended (`not_found`).' },
  },
  release: {
    tag: 'Numbers',
    auth: 'owner',
    summary: 'Release a number',
    description:
      'Stops renewing the number. It keeps working (and routing) until `paidUntil`, the end of the period already ' +
      'paid for; nothing is refunded. Releasing twice is fine.',
    params: IdParams,
    responses: { 200: { description: 'The released number', schema: NumberSchema } },
    errors: { 404: 'No such number in this account (`not_found`).', 502: 'The number provider failed (`did_provider_error`); retry.' },
  },
} satisfies Record<string, OperationDoc>;

const COLUMNS = 'id, did, status, kind, destination, paid_until, purchased_at';

export const numberRoutes: FastifyPluginAsync<{ sql: Sql; stripe: StripeClient; provider: DidProvider }> = async (
  app,
  { sql, stripe, provider },
) => {
  const anyUser = { preHandler: [authenticate] };
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };
  const cols = sql.unsafe(COLUMNS);

  app.get('/numbers', withDoc(anyUser, docs.list), async (req) =>
    withRetry(
      () => sql<PhoneNumber[]>`
        select ${cols} from phone_numbers
         where tenant_id = ${tenantOf(req)} and (status = 'assigned' or paid_until > now())
         order by did`,
    ),
  );

  app.get('/numbers/countries', withDoc(ownerOnly, docs.countries), async () => provider.countries());

  app.get('/numbers/regions', withDoc(ownerOnly, docs.regions), async (req) => provider.regions(parse(RegionsQuery, req.query).country));

  app.get('/numbers/cities', withDoc(ownerOnly, docs.cities), async (req) => {
    const q = parse(CitiesQuery, req.query);
    return provider.cities(q.country, q.regionId);
  });

  app.get('/numbers/available', withDoc(ownerOnly, docs.available), async (req) => {
    const q = parse(AvailableQuery, req.query);
    const [t] = await withRetry(
      () => sql<{ timezone: string; createdAt: Date }[]>`select timezone, created_at from tenants where id = ${tenantOf(req)}`,
    );
    const now = new Date();
    const period = billingPeriod(t!.timezone, t!.createdAt, now);
    const offers = await provider.searchAvailable(q);
    // Our cost (incomingCostPerMin) stays internal; customers see our prices (GET /billing/prices).
    return offers.map(({ skuId: _sku, incomingCostPerMin: _cost, ...o }) => {
      const priceCents = numberPriceCents(o.kind);
      const due = proratedCents(priceCents, period, now);
      return { ...o, priceCents, dueNowCents: due < 50 ? 0 : due };
    });
  });

  app.post('/numbers/purchase', withDoc(ownerOnly, docs.purchase), async (req, reply) => {
    const tenantId = tenantOf(req);
    const header = req.headers['idempotency-key'];
    const clientKey = parse(IdempotencyKey, Array.isArray(header) ? header[0] : header);
    const { availableNumberId } = parse(PurchaseBody, req.body);
    const result = await purchaseNumber({ sql, stripe, provider, log: req.log }, { tenantId, clientKey, availableNumberId });
    if (result.status === 'processing') {
      return reply
        .status(202)
        .header('Retry-After', '2')
        .send({ status: 'processing', message: 'The provider is still processing the order; repeat this request with the same Idempotency-Key' });
    }
    const [number] = await withRetry(
      () => sql<PhoneNumber[]>`select ${cols} from phone_numbers where id = ${result.phoneNumberId} and tenant_id = ${tenantId}`,
    );
    if (!number) throw new Error(`purchased number ${result.phoneNumberId} not found`);
    return reply.status(201).send({ number, chargedCents: result.chargedCents, replayed: result.replayed });
  });

  app.get('/numbers/:id', withDoc(anyUser, docs.get), async (req) => {
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(
      () => sql<PhoneNumber[]>`select ${cols} from phone_numbers where id = ${id} and tenant_id = ${tenantOf(req)}`,
    );
    if (!row) throw notFound();
    return row;
  });

  app.put('/numbers/:id/route', withDoc(ownerOnly, docs.route), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const { destination } = parse(RouteBody, req.body);
    return withRetry(() =>
      sql.begin(async (tx) => {
        // Locks the target FOR SHARE, so a concurrent delete of it sees this route.
        await assertOwned(tx, tenantId, destinationRefs(destination, 'destination'));
        // ivr_menu_id is the phase-1 column; kept in sync for anything still reading it.
        const ivrMenuId = destination?.type === 'ivr_menu' ? destination.id : null;
        // A released number still routes calls until paidUntil, so it can be re-routed until then
        // (e.g. to free an extension the owner wants to delete). After that it is "not found".
        const [row] = await tx<PhoneNumber[]>`
          update phone_numbers
             set destination = ${destination ? tx.json(destination) : null}, ivr_menu_id = ${ivrMenuId}
           where id = ${id} and tenant_id = ${tenantId} and (status = 'assigned' or paid_until > now())
          returning ${cols}`;
        if (!row) throw notFound();
        return row;
      }),
    );
  });

  app.delete('/numbers/:id', withDoc(ownerOnly, docs.release), async (req) => {
    const tenantId = tenantOf(req);
    const { id } = parse(IdParams, req.params);
    const [row] = await withRetry(
      () => sql<(PhoneNumber & { providerRef: string | null })[]>`
        select ${cols}, provider_ref from phone_numbers where id = ${id} and tenant_id = ${tenantId}`,
    );
    if (!row) throw notFound();
    if (row.status === 'released') {
      const { providerRef: _r, ...number } = row;
      return number;
    }
    // Provider first: if it fails nothing changed here and the client retries. If the DB update
    // fails after it, a retry releases at the provider again, which is harmless.
    if (row.providerRef) await provider.release(row.providerRef);
    const [released] = await withRetry(() =>
      sql.begin(async (tx) => {
        const rows = await tx<PhoneNumber[]>`
          update phone_numbers set status = 'released'
           where id = ${id} and tenant_id = ${tenantId}
          returning ${cols}`;
        // Not renewed any more; it keeps working until paid_through (= paid_until).
        await tx`
          update account_items set removed_at = now()
           where phone_number_id = ${id} and tenant_id = ${tenantId} and removed_at is null`;
        return rows;
      }),
    );
    if (!released) throw notFound();
    req.log.info({ tenantId, did: released.did, paidUntil: released.paidUntil }, 'number released');
    return released;
  });
};
