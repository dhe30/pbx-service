import { billingPeriod, withRetry, type Db } from '@pbx/shared';
import { MIN_CHARGE_CENTS, proratedCents } from './catalog.js';
import type { StripeClient } from './stripe.js';

// "Items bought mid-period (including the plan at signup) are charged immediately, prorated
// linearly to period end" (course spec §5, docs/billing-flows.md §3). Shared by number purchases
// and item purchases (add-ons, extra extensions).

export type ProratedCharge =
  | { ok: true; cents: number; paidUntil: Date; periodStart: string }
  | { ok: false; message: string };

/**
 * Charges `priceCents` prorated to the end of the account's current billing period, on the saved
 * card, and records the attempt in `payments`. `chargeKey` is the Stripe Idempotency-Key and the
 * payments row key: calling again with the same key never charges twice. Amounts below Stripe's
 * minimum are waived (recorded as a 0 payment).
 */
export async function chargeProrated(
  d: { sql: Db; stripe: StripeClient },
  p: { tenantId: string; chargeKey: string; priceCents: number; purpose: string; description: string },
  now: Date,
): Promise<ProratedCharge> {
  const { sql } = d;
  const [acct] = await withRetry(
    () => sql<{ timezone: string; createdAt: Date; stripeCustomerId: string; paymentMethodId: string | null }[]>`
      select t.timezone, t.created_at, ba.stripe_customer_id, ba.payment_method_id
        from tenants t join billing_accounts ba on ba.tenant_id = t.id
       where t.id = ${p.tenantId}`,
  );
  if (!acct?.paymentMethodId) return { ok: false, message: 'no saved card' };
  const period = billingPeriod(acct.timezone, acct.createdAt, now);

  // Already charged by an earlier attempt? (Stripe would replay it anyway; this skips the call.)
  const [prev] = await withRetry(
    () => sql<{ status: string; amountCents: number }[]>`
      select status, amount_cents from payments where idempotency_key = ${p.chargeKey}`,
  );
  if (prev?.status === 'succeeded') return { ok: true, cents: prev.amountCents, paidUntil: period.end, periodStart: period.startDate };

  const cents = proratedCents(p.priceCents, period, now);
  const record = (status: 'succeeded' | 'failed', paymentIntentId: string | null, message: string | null, amount: number) =>
    withRetry(
      () => sql`
        insert into payments (tenant_id, purpose, period_start, idempotency_key, amount_cents,
                              stripe_payment_intent_id, status, failure_message)
        values (${p.tenantId}, ${p.purpose}, ${period.startDate}, ${p.chargeKey}, ${amount}, ${paymentIntentId}, ${status}, ${message})
        on conflict (idempotency_key) do update
          set status = excluded.status, stripe_payment_intent_id = excluded.stripe_payment_intent_id,
              failure_message = excluded.failure_message`,
    );

  if (cents < MIN_CHARGE_CENTS) {
    await record('succeeded', null, 'below minimum charge, waived', 0);
    return { ok: true, cents: 0, paidUntil: period.end, periodStart: period.startDate };
  }
  const result = await d.stripe.charge(
    { customerId: acct.stripeCustomerId, paymentMethodId: acct.paymentMethodId, amountCents: cents, description: p.description, tenantId: p.tenantId },
    p.chargeKey,
  );
  if (!result.ok) {
    await record('failed', result.paymentIntentId, result.message, cents);
    return { ok: false, message: result.message };
  }
  await record('succeeded', result.paymentIntentId, null, cents);
  return { ok: true, cents, paidUntil: period.end, periodStart: period.startDate };
}
