import { billingPeriod, withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../auth.js';
import { saveCard, startCardSetup } from '../billing/account.js';
import { PLAN, PRICES } from '../billing/catalog.js';
import type { StripeClient } from '../billing/stripe.js';
import { withDoc, type OperationDoc } from '../openapi/document.js';
import { tenantOf } from '../tenancy.js';
import { parse } from '../validation.js';

// Card and plan (course spec §1 signup card, §2 prices, §5 billing). Flow: docs/billing-flows.md.
//
// GET  /billing/prices              public   200 prices       (shown before signup / purchase)
// GET  /billing                     owner    200 billing      card, plan state, extension usage
// POST /billing/setup-intent        owner    201 cardSetup    to save or replace the card
// POST /billing/card {setupIntentId} owner   200 billing      400, 402 payment_failed
//
// Saving a card: POST /billing/setup-intent (signup already returns one) -> in the browser,
// Stripe.js (loaded from stripeJsUrl, with publishableKey) stripe.confirmCardSetup(clientSecret,
// { payment_method: { card } }) -> POST /billing/card { setupIntentId }. The first card also pays
// the plan, prorated to the end of the current billing period.

export interface BillingOptions {
  sql: Sql;
  stripe: StripeClient;
  publishableKey: string;
  stripeJsUrl: string;
}

const cents = (d: string) => z.number().int().describe(`${d} (US cents per 7-day billing period).`);
const PricesSchema = z
  .object({
    currency: z.literal('usd').describe('Currency of every amount.'),
    billingPeriodDays: z.literal(7).describe("Billing period length: 7 days from local midnight (account time zone) on the signup weekday."),
    plan: z
      .object({
        name: z.string().describe('Plan name.'),
        priceCents: cents('Plan price'),
        includedExtensions: z.number().int().describe('Extensions included.'),
        includedUsMinutes: z.number().int().describe('US outgoing minutes included per period, shared by the account.'),
      })
      .describe('The base plan. Charged at signup, prorated to the end of the first period.'),
    extensionCents: cents('Each additional extension'),
    localNumberCents: cents('Local phone number'),
    tollFreeNumberCents: cents('Toll-free phone number'),
    intlCallingCents: cents('International calling add-on'),
    recordingCents: cents('Call recording add-on'),
    perMinute: z
      .object({
        usPerMin: z.number().describe('US outgoing calls beyond the included minutes, USD per minute.'),
        tollFreeInPerMin: z.number().describe('Incoming calls on toll-free numbers, USD per minute.'),
        intlMultiplier: z.number().describe('International calls: the vendor rate for the destination prefix times this.'),
        intlMinPerMin: z.number().describe('International calls: minimum USD per minute.'),
      })
      .describe('Per-minute prices, billed in 30/6-second increments. Internal and other incoming calls are free.'),
  })
  .describe('Price list.');

const CardSetupSchema = z
  .object({
    setupIntentId: z.string().describe('Stripe SetupIntent id; send it to POST /billing/card once the card is confirmed.'),
    clientSecret: z
      .string()
      .describe('SetupIntent client_secret: pass to Stripe.js stripe.confirmCardSetup(clientSecret, ...) in the browser.'),
    publishableKey: z.string().describe('Stripe publishable key for Stripe(publishableKey).'),
    stripeJsUrl: z.string().describe('Load Stripe.js from this URL (the course payment gateway).'),
  })
  .describe('Everything the browser needs to save a card with Stripe.js. Card numbers never go to this API.');

const BillingSchema = z
  .object({
    card: z
      .object({
        brand: z.string().nullable().describe('Card brand, e.g. visa.'),
        last4: z.string().nullable().describe('Last 4 digits.'),
      })
      .nullable()
      .describe('The saved default card; null = none yet.'),
    planPaidThrough: z.date().nullable().describe('End of the period the plan is paid for; null = not paid yet (extensions cannot be added).'),
    currentPeriod: z
      .object({ start: z.date().describe('Period start.'), end: z.date().describe('Period end (exclusive).') })
      .describe('The current billing period.'),
    extensions: z
      .object({
        used: z.number().int().describe('Extensions the account has.'),
        allowed: z.number().int().describe('Included in the plan plus bought.'),
      })
      .describe('Extension limit.'),
  })
  .describe("The account's billing state.");

const SaveCardBody = z.object({
  setupIntentId: z.string().min(1).max(255).describe('The SetupIntent the browser confirmed with Stripe.js.'),
});

const docs = {
  prices: {
    tag: 'Billing',
    auth: 'public',
    summary: 'Price list',
    description: 'Plan, items and per-minute prices, as charged. Show these before signup and before every purchase.',
    responses: { 200: { description: 'Prices', schema: PricesSchema } },
  },
  get: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Billing state',
    responses: { 200: { description: 'Card, plan and extension usage', schema: BillingSchema } },
  },
  setupIntent: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Start saving a card',
    description:
      'Creates a Stripe SetupIntent and returns its client_secret for Stripe.js. Use it to add the first card (if ' +
      'signup did not return one) or to replace the card. Then call POST /billing/card.',
    responses: { 201: { description: 'Card setup started', schema: CardSetupSchema } },
    errors: { 502: 'The payment gateway failed (`payment_gateway_error`); retry.' },
  },
  card: {
    tag: 'Billing',
    auth: 'owner',
    summary: 'Save the confirmed card',
    description:
      'Call after stripe.confirmCardSetup succeeded. The API checks the SetupIntent with Stripe, makes the card the ' +
      "default, and if the plan isn't paid yet charges it now, prorated to the end of the current period. " +
      'Safe to retry: it never charges twice.',
    body: SaveCardBody,
    responses: { 200: { description: 'Card saved (and plan paid if it was due)', schema: BillingSchema } },
    errors: {
      402: 'Card saved, but the plan charge was declined (`payment_failed`); start again with another card.',
      502: 'The payment gateway failed (`payment_gateway_error`); retry.',
    },
  },
} satisfies Record<string, OperationDoc>;

export const billingRoutes: FastifyPluginAsync<BillingOptions> = async (app, opts) => {
  const { sql, stripe } = opts;
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  async function billingState(tenantId: string) {
    const [row] = await withRetry(
      () => sql<
        {
          timezone: string;
          createdAt: Date;
          paymentMethodId: string | null;
          cardBrand: string | null;
          cardLast4: string | null;
          planPaidThrough: Date | null;
          allowed: number;
          used: number;
        }[]
      >`
        select t.timezone, t.created_at, ba.payment_method_id, ba.card_brand, ba.card_last4, ba.plan_paid_through,
               coalesce(ts.included_extensions + ts.extra_extensions, 0) as allowed,
               (select count(*)::int from extensions e where e.tenant_id = t.id) as used
          from tenants t
          left join billing_accounts ba on ba.tenant_id = t.id
          left join tenant_settings ts on ts.tenant_id = t.id
         where t.id = ${tenantId}`,
    );
    const r = row!;
    const period = billingPeriod(r.timezone, r.createdAt, new Date());
    return {
      card: r.paymentMethodId ? { brand: r.cardBrand, last4: r.cardLast4 } : null,
      planPaidThrough: r.planPaidThrough,
      currentPeriod: { start: period.start, end: period.end },
      extensions: { used: r.used, allowed: r.allowed },
    };
  }

  app.get('/billing/prices', withDoc({}, docs.prices), async () => {
    const [p] = await withRetry(
      () => sql<{ usPerMin: string; tollFreeInPerMin: string; intlMultiplier: string; intlMinPerMin: string }[]>`
        select us_per_min, toll_free_in_per_min, intl_multiplier, intl_min_per_min from call_pricing`,
    );
    return {
      currency: 'usd',
      billingPeriodDays: 7,
      plan: { ...PLAN },
      ...PRICES,
      // numeric columns arrive as strings
      perMinute: {
        usPerMin: Number(p!.usPerMin),
        tollFreeInPerMin: Number(p!.tollFreeInPerMin),
        intlMultiplier: Number(p!.intlMultiplier),
        intlMinPerMin: Number(p!.intlMinPerMin),
      },
    };
  });

  app.get('/billing', withDoc(ownerOnly, docs.get), async (req) => billingState(tenantOf(req)));

  app.post('/billing/setup-intent', withDoc(ownerOnly, docs.setupIntent), async (req, reply) => {
    const setup = await startCardSetup(sql, stripe, tenantOf(req));
    return reply.status(201).send({ ...setup, publishableKey: opts.publishableKey, stripeJsUrl: opts.stripeJsUrl });
  });

  app.post('/billing/card', withDoc(ownerOnly, docs.card), async (req) => {
    const tenantId = tenantOf(req);
    const { setupIntentId } = parse(SaveCardBody, req.body);
    await saveCard(sql, stripe, tenantId, setupIntentId, req.log);
    return billingState(tenantId);
  });
};
