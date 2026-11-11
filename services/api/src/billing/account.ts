import { billingPeriod, withRetry, type Db, type Sql } from '@pbx/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from '../errors.js';
import { MIN_CHARGE_CENTS, PLAN, proratedCents } from './catalog.js';
import { payOverdue } from './scheduler.js';
import type { StripeClient } from './stripe.js';

// Saved card + first plan charge (docs/billing-flows.md §1, steps 2-7):
//   startCardSetup(): Stripe customer (once per account) + a SetupIntent; its client_secret goes
//     to the browser, which saves the card with Stripe.js (confirmCardSetup). Card numbers never
//     reach us.
//   saveCard(): the browser reports the SetupIntent id. We retrieve it from Stripe ourselves
//     (never trusting the browser's word), check it succeeded for THIS account's customer, make
//     the card the default, and, if the plan was never paid, charge it prorated to period end.
// Later charges (weekly invoices, past-due recovery) belong to the billing scheduler (not built).

export interface CardSetup {
  setupIntentId: string;
  clientSecret: string;
}

interface Account {
  stripeCustomerId: string;
  paymentMethodId: string | null;
  planPaidThrough: Date | null;
}

const getAccount = (db: Db, tenantId: string) =>
  db<Account[]>`
    select stripe_customer_id, payment_method_id, plan_paid_through from billing_accounts where tenant_id = ${tenantId}`;

/** The account's Stripe customer id, creating the customer on first use. */
async function ensureCustomer(sql: Sql, stripe: StripeClient, tenantId: string): Promise<string> {
  const [existing] = await withRetry(() => getAccount(sql, tenantId));
  if (existing) return existing.stripeCustomerId;
  const [t] = await withRetry(
    () => sql<{ name: string; email: string }[]>`
      select t.name, u.email from tenants t
        join users u on u.tenant_id = t.id and u.role = 'owner'
       where t.id = ${tenantId}
       order by u.created_at limit 1`,
  );
  if (!t) throw new HttpError(404, 'not_found', 'No such account');
  // Same key for every attempt: concurrent or retried calls get the same customer.
  const customer = await stripe.createCustomer({ name: t.name, email: t.email, tenantId }, `customer:${tenantId}`);
  await withRetry(
    () => sql`
      insert into billing_accounts (tenant_id, stripe_customer_id) values (${tenantId}, ${customer.id})
      on conflict (tenant_id) do nothing`,
  );
  const [acct] = await withRetry(() => getAccount(sql, tenantId));
  return acct!.stripeCustomerId;
}

/** A fresh SetupIntent for saving (or replacing) the account's card. */
export async function startCardSetup(sql: Sql, stripe: StripeClient, tenantId: string): Promise<CardSetup> {
  const customerId = await ensureCustomer(sql, stripe, tenantId);
  const si = await stripe.createSetupIntent(customerId, `setup-intent:${tenantId}:${randomUUID()}`);
  return { setupIntentId: si.id, clientSecret: si.clientSecret };
}

export interface SaveCardResult {
  /** Amount of the first plan charge made now, in cents (0 if nothing was due or it was waived). */
  chargedCents: number;
}

export async function saveCard(
  sql: Sql,
  stripe: StripeClient,
  tenantId: string,
  setupIntentId: string,
  log: FastifyBaseLogger,
  now = new Date(),
): Promise<SaveCardResult> {
  const [acct] = await withRetry(() => getAccount(sql, tenantId));
  const notOurs = new HttpError(400, 'invalid_request', 'setupIntentId: no such card setup for this account');
  if (!acct) throw notOurs;

  // Never trust the browser: ask Stripe what happened to this SetupIntent.
  const si = await stripe.retrieveSetupIntent(setupIntentId).catch((err: unknown) => {
    if ((err as { status?: number }).status === 404) throw notOurs;
    throw err;
  });
  if (si.customer !== acct.stripeCustomerId) throw notOurs;
  if (si.status !== 'succeeded' || !si.paymentMethod) {
    throw new HttpError(400, 'card_not_saved', `setupIntentId: the card was not saved (status ${si.status}); confirm it with Stripe.js first`);
  }
  const pm = si.paymentMethod;

  await stripe.setDefaultPaymentMethod(acct.stripeCustomerId, pm, `default-pm:${acct.stripeCustomerId}:${pm}`);
  // Brand / last 4 are for display only; don't fail the save if the lookup fails.
  const card = await stripe.retrieveCard(pm).catch((err: unknown) => {
    log.warn({ err, tenantId }, 'could not read card details');
    return { brand: null, last4: null };
  });
  await withRetry(
    () => sql`
      update billing_accounts
         set payment_method_id = ${pm}, card_brand = ${card.brand}, card_last4 = ${card.last4}, updated_at = now()
       where tenant_id = ${tenantId}`,
  );

  if (!acct.planPaidThrough) return chargeFirstPeriod(sql, stripe, tenantId, acct.stripeCustomerId, pm, log, now);

  // A replacement card. Billing-flows §5: "charge every overdue invoice immediately; on success set
  // status active" (the scheduler's charge reactivates the account; the call path unblocks within
  // seconds through NOTIFY pbx_config, well inside the spec's one minute).
  const overdue = await payOverdue({ sql, stripe, log }, tenantId, now);
  if (overdue.unpaid > 0) {
    throw new HttpError(
      402,
      'payment_failed',
      `The card was saved, but the unpaid invoice could not be charged: ${overdue.lastError ?? 'declined'}. Add another card.`,
    );
  }
  if (overdue.paid > 0) log.info({ tenantId, invoices: overdue.paid }, 'overdue invoices paid with a new card');
  return { chargedCents: 0 };
}

/** "Items bought mid-period (including the plan at signup) are charged immediately, prorated." */
async function chargeFirstPeriod(
  sql: Sql,
  stripe: StripeClient,
  tenantId: string,
  customerId: string,
  paymentMethodId: string,
  log: FastifyBaseLogger,
  now: Date,
): Promise<SaveCardResult> {
  const [t] = await withRetry(() => sql<{ timezone: string; createdAt: Date }[]>`
    select timezone, created_at from tenants where id = ${tenantId}`);
  const period = billingPeriod(t!.timezone, t!.createdAt, now);
  const amountCents = proratedCents(PLAN.priceCents, period, now);
  // Per period AND card: retrying with the same card reuses Stripe's result (never charges twice);
  // a new card after a decline gets a new attempt (Stripe would replay the cached decline).
  const key = `plan:${tenantId}:${period.startDate}:${paymentMethodId}`;

  const record = (status: 'succeeded' | 'failed', paymentIntentId: string | null, message: string | null, cents: number) =>
    withRetry(
      () => sql`
        insert into payments (tenant_id, purpose, period_start, idempotency_key, amount_cents,
                              stripe_payment_intent_id, status, failure_message)
        values (${tenantId}, 'plan', ${period.startDate}, ${key}, ${cents}, ${paymentIntentId}, ${status}, ${message})
        on conflict (idempotency_key) do update
          set status = excluded.status, stripe_payment_intent_id = excluded.stripe_payment_intent_id,
              failure_message = excluded.failure_message`,
    );
  // The plan becomes a recurring account item (renewed weekly by the billing scheduler).
  const markPaid = () =>
    withRetry(() =>
      sql.begin(async (tx) => {
        const updated = await tx`
          update billing_accounts set plan_paid_through = ${period.end}, updated_at = now()
           where tenant_id = ${tenantId} and plan_paid_through is null
          returning tenant_id`;
        if (updated.length === 0) return;
        await tx`
          insert into account_items (tenant_id, kind, price_cents, paid_through)
          values (${tenantId}, 'plan', ${PLAN.priceCents}, ${period.end})`;
      }),
    );

  if (amountCents < MIN_CHARGE_CENTS) {
    // Below Stripe's minimum charge (only possible minutes before the period ends): waive it.
    await record('succeeded', null, 'below minimum charge, waived', 0);
    await markPaid();
    return { chargedCents: 0 };
  }

  const result = await stripe.charge(
    { customerId, paymentMethodId, amountCents, description: `${PLAN.name} plan, first period (prorated)`, tenantId },
    key,
  );
  if (!result.ok) {
    await record('failed', result.paymentIntentId, result.message, amountCents);
    log.info({ tenantId, amountCents, reason: result.message }, 'plan charge failed');
    throw new HttpError(402, 'payment_failed', `The card was saved, but the plan charge failed: ${result.message}. Add another card.`);
  }
  await record('succeeded', result.paymentIntentId, null, amountCents);
  await markPaid();
  log.info({ tenantId, amountCents }, 'plan paid');
  return { chargedCents: amountCents };
}
