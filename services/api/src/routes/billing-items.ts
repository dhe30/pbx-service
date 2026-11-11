import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { BUYABLE, ITEM_PRICE_CENTS, buyItem, cancelItem, listItems } from '../billing/items.js';
import { IDEMPOTENCY_KEY_RE } from '../billing/purchase-requests.js';
import type { StripeClient } from '../billing/stripe.js';
import { HttpError } from '../errors.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { IdParams, tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';

// What the account pays for every billing period, and buying / cancelling extra extensions and
// add-ons (course spec §2 "additional extensions; international calling; call recording", §5
// "items bought mid-period are charged immediately, prorated"; docs/billing-flows.md §3).
//
// GET    /billing/items                       owner  200 [item]   active items (plan, extensions, numbers, add-ons)
// POST   /billing/items { kind } + Idempotency-Key
//                                             owner  201 { item, chargedCents, replayed }
//                                                    402 payment_required | payment_failed, 409 already_active |
//                                                    idempotency_key_reused | purchase_in_progress, 502
// DELETE /billing/items/:id                   owner  200 item     cancelled: works until paidThrough, not renewed
//                                                    400 (plan, numbers), 404, 409 extension_limit

const KINDS = ['plan', 'extension', 'number', 'intl_calling', 'recording'] as const;

const BuyBody = z
  .object({
    kind: z
      .enum(BUYABLE)
      .describe('extension: one more extension slot. intl_calling: international calling add-on. recording: call recording add-on.'),
  })
  .strict()
  .describe('What to buy.');

const IdempotencyKey = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .regex(IDEMPOTENCY_KEY_RE, 'Idempotency-Key must be 1-200 letters, digits or _.:-');

const ItemSchema = z
  .object({
    id: z.string().uuid().describe('Item id.'),
    kind: z.enum(KINDS).describe('plan, extension (additional extension), number, intl_calling or recording.'),
    priceCents: z.number().int().describe('Price per 7-day billing period, US cents (charged again at each renewal).'),
    startedAt: z.date().describe('When it was bought.'),
    paidThrough: z.date().describe('End of the period it is paid for.'),
    removedAt: z.date().nullable().describe('When it was cancelled; null = renews every period.'),
    renews: z.boolean().describe('false = cancelled: keeps working until paidThrough, then ends.'),
    phoneNumberId: z.string().uuid().nullable().describe('For kind number: the number (GET /numbers/{id}).'),
    did: z.string().nullable().describe('For kind number: the number, E.164.'),
  })
  .describe('Something the account pays for every billing period.');

const BuyResultSchema = z
  .object({
    item: ItemSchema,
    chargedCents: z.number().int().describe('Charged to the saved card now (prorated to the end of the current period), US cents.'),
    replayed: z.boolean().describe('true = this Idempotency-Key was already completed; nothing new was bought or charged.'),
  })
  .describe('The bought item.');

const docs = {
  list: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Recurring items',
    description:
      'Everything the account pays for each billing period: the plan, additional extensions, numbers and add-ons. ' +
      'Includes cancelled items until their paid period ends (`renews: false`).',
    responses: { 200: { description: 'The items', schema: z.array(ItemSchema).describe('Items: plan, extensions, numbers, add-ons.') } },
  },
  buy: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Buy an additional extension or an add-on',
    description:
      `Charges the saved card the item's price prorated to the end of the current billing period, then activates it. ` +
      `Prices per period (also in GET /billing/prices): extension ${ITEM_PRICE_CENTS.extension}, intl_calling ` +
      `${ITEM_PRICE_CENTS.intl_calling}, recording ${ITEM_PRICE_CENTS.recording} cents. An additional extension raises the ` +
      'extension limit by one (GET /billing). Buying a cancelled add-on that is still paid for renews it again at no charge. ' +
      '**Idempotent:** send a unique Idempotency-Key per purchase and reuse it for retries; it never charges twice.',
    headers: { 'Idempotency-Key': { description: 'Unique per purchase (e.g. a UUID), 1-200 of A-Z a-z 0-9 _ . : -. Reuse it to retry.', required: true } },
    body: BuyBody,
    responses: { 201: { description: 'Bought (or replayed)', schema: BuyResultSchema } },
    errors: {
      402: 'No saved card / plan not paid / account past due (`payment_required`), or the card was declined (`payment_failed`; nothing was bought).',
      409:
        'The add-on is already active (`already_active`), this key was used for a different purchase (`idempotency_key_reused`), ' +
        'or another request with this key is running (`purchase_in_progress`).',
      502: 'The payment service failed (`payment_gateway_error`). Retry with the same Idempotency-Key.',
    },
  },
  cancel: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Cancel an additional extension or an add-on',
    description:
      'Stops renewing the item. An add-on keeps working until `paidThrough`; nothing is refunded. A cancelled extension ' +
      'slot lowers the extension limit at once, so it can only be cancelled while the extensions in use fit without it. ' +
      'Cancelling twice is fine. Numbers are released with DELETE /numbers/{id}; the plan cannot be cancelled.',
    params: IdParams,
    responses: { 200: { description: 'The cancelled item', schema: ItemSchema } },
    errors: {
      400: 'The plan or a number (`invalid_request`).',
      404: 'No such active item in this account (`not_found`).',
      409: 'More extensions are in use than the limit without this slot (`extension_limit`); delete an extension first.',
    },
  },
} satisfies Record<string, OperationDoc>;

export const billingItemRoutes: FastifyPluginAsync<{ sql: Sql; stripe: StripeClient }> = async (app, { sql, stripe }) => {
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  app.get('/billing/items', withDoc(ownerOnly, docs.list), async (req) => withRetry(() => listItems(sql, tenantOf(req))));

  app.post('/billing/items', withDoc(ownerOnly, docs.buy), async (req, reply) => {
    const tenantId = tenantOf(req);
    const header = req.headers['idempotency-key'];
    const clientKey = parse(IdempotencyKey, Array.isArray(header) ? header[0] : header);
    const { kind } = parse(BuyBody, req.body);
    const result = await buyItem({ sql, stripe, log: req.log }, { tenantId, clientKey, kind });
    // Listed while active; a replay long after the item ended reads it without that filter.
    const [item] = await withRetry(
      () => sql`
        select i.id, i.kind, i.price_cents, i.started_at, i.paid_through, i.removed_at, i.removed_at is null as renews,
               i.phone_number_id, null::text as did
          from account_items i where i.id = ${result.itemId} and i.tenant_id = ${tenantId}`,
    );
    if (!item) throw new HttpError(404, 'not_found', 'The bought item no longer exists');
    return reply.status(201).send({ item, chargedCents: result.chargedCents, replayed: result.replayed });
  });

  app.delete('/billing/items/:id', withDoc(ownerOnly, docs.cancel), async (req) => {
    const { id } = parse(IdParams, req.params);
    const item = await cancelItem(sql, tenantOf(req), id);
    req.log.info({ tenantId: tenantOf(req), itemId: id, kind: item.kind }, 'account item cancelled');
    return item;
  });
};
