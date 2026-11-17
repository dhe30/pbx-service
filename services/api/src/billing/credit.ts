import { withRetry, type Db, type Sql } from '@pbx/shared';
import type { FastifyBaseLogger } from 'fastify';
import { PREPAID, topUpCents } from './catalog.js';
import type { StripeClient } from './stripe.js';

// Prepaid usage (catalog.ts PREPAID; migration
// 20261120000000_prepaid_credit.sql).
//
// Every account has a credit balance (credit_balances). Charged call legs are deducted by a trigger
// on cdrs as the calls end. Whenever the balance is below the threshold (one top-up), one top-up is
// charged to the saved card and added to the balance: at signup (saveCard) and in every billing
// tick. Calls are never refused for lack of credit, so the balance may dip below zero until the
// next top-up goes through. A declined top-up is retried with backoff; the account keeps calling.
//
// Concurrency: the account's billing_accounts row is locked (SKIP LOCKED) for the whole attempt,
// so app nodes never charge the same top-up twice. The deduction trigger only touches
// credit_balances, so calls never wait for a top-up in progress. The Stripe Idempotency-Key is
// topup:<tenant>:<n>:<attempt>: a retried transaction replays the same charge, a new attempt after
// a decline really tries again.

export interface CreditDeps {
  sql: Sql;
  stripe: StripeClient;
  log: FastifyBaseLogger;
}

/** Wait after a declined top-up attempt (attempt 1, 2, ...), then the last one repeats. */
export const TOPUP_RETRY_DELAYS_SEC = [60, 5 * 60, 15 * 60, 3600];

export interface CreditState {
  balanceCents: number;
  topUpCents: number;
  thresholdCents: number;
  extensions: number;
  lastTopUpAt: Date | null;
}

/** What GET /billing reports about the credit balance. */
export async function creditState(db: Db, tenantId: string): Promise<CreditState> {
  const [r] = await db<{ credit: string | null; extensions: number; lastTopUpAt: Date | null }[]>`
    select (select credit from credit_balances where tenant_id = ${tenantId}) as credit,
           (select count(*)::int from extensions where tenant_id = ${tenantId}) as extensions,
           (select max(created_at) from payments
             where tenant_id = ${tenantId} and purpose = 'topup' and status = 'succeeded') as last_top_up_at`;
  const topUp = topUpCents(r?.extensions ?? 0);
  return {
    balanceCents: Math.round(Number(r?.credit ?? 0) * 100),
    topUpCents: topUp,
    thresholdCents: topUp,
    extensions: r?.extensions ?? 0,
    lastTopUpAt: r?.lastTopUpAt ?? null,
  };
}

interface DueAccount {
  tenantId: string;
  stripeCustomerId: string;
  paymentMethodId: string;
  topupSeq: number;
  topupAttempts: number;
  credit: string;
  extensions: number;
}

/**
 * Charges one top-up to the next account whose balance is below its threshold (or to `tenantId`
 * only). 'charged' / 'failed' = one attempt made, null = no account due.
 */
export async function rechargeNext(d: CreditDeps, now: Date, tenantId?: string): Promise<'charged' | 'failed' | null> {
  return withRetry(() =>
    d.sql.begin(async (tx) => {
      const [a] = await tx<DueAccount[]>`
        select ba.tenant_id, ba.stripe_customer_id, ba.payment_method_id, ba.topup_seq, ba.topup_attempts,
               coalesce(cb.credit, 0) as credit, x.n as extensions
          from billing_accounts ba
          join tenants t on t.id = ba.tenant_id
          left join credit_balances cb on cb.tenant_id = ba.tenant_id
          cross join lateral (select count(*)::int as n from extensions e where e.tenant_id = ba.tenant_id) x
         where t.prepaid_since is not null
           and ba.payment_method_id is not null
           and ba.plan_paid_through is not null
           and (ba.topup_retry_at is null or ba.topup_retry_at <= ${now})
           and coalesce(cb.credit, 0) * 100 < ${PREPAID.topUpCentsPer10Extensions} * greatest(1, ceil(x.n / 10.0))
           ${tenantId ? tx`and ba.tenant_id = ${tenantId}` : tx``}
         order by coalesce(cb.credit, 0)
         limit 1
           for update of ba skip locked`;
      if (!a) return null;
      return chargeTopUp(d, tx, a, now);
    }),
  );
}

async function chargeTopUp(d: CreditDeps, tx: Db, a: DueAccount, now: Date): Promise<'charged' | 'failed'> {
  const amountCents = topUpCents(a.extensions);
  const attempt = a.topupAttempts + 1;
  const key = `topup:${a.tenantId}:${a.topupSeq + 1}:${attempt}`;
  let paymentIntentId: string | null = null;
  let error: string | null = null;
  try {
    const result = await d.stripe.charge(
      {
        customerId: a.stripeCustomerId,
        paymentMethodId: a.paymentMethodId,
        amountCents,
        description: `Prepaid credit top-up (${a.extensions} extension${a.extensions === 1 ? '' : 's'})`,
        tenantId: a.tenantId,
      },
      key,
    );
    paymentIntentId = result.paymentIntentId;
    if (!result.ok) error = result.message;
  } catch (err) {
    error = `payment gateway error: ${(err as Error).message}`;
  }

  await tx`
    insert into payments (tenant_id, purpose, idempotency_key, amount_cents, stripe_payment_intent_id, status, failure_message, created_at)
    values (${a.tenantId}, 'topup', ${key}, ${amountCents}, ${paymentIntentId}, ${error ? 'failed' : 'succeeded'}, ${error}, ${now})
    on conflict (idempotency_key) do update
      set status = excluded.status, stripe_payment_intent_id = excluded.stripe_payment_intent_id,
          failure_message = excluded.failure_message`;

  if (error) {
    const delay = TOPUP_RETRY_DELAYS_SEC[Math.min(attempt, TOPUP_RETRY_DELAYS_SEC.length) - 1]!;
    await tx`
      update billing_accounts
         set topup_attempts = ${attempt}, topup_retry_at = ${new Date(now.getTime() + delay * 1000)}, updated_at = now()
       where tenant_id = ${a.tenantId}`;
    d.log.warn({ tenantId: a.tenantId, amountCents, attempt, error }, 'prepaid top-up failed');
    return 'failed';
  }
  await tx`
    insert into credit_balances (tenant_id, credit) values (${a.tenantId}, ${(amountCents / 100).toFixed(2)})
    on conflict (tenant_id) do update set credit = credit_balances.credit + excluded.credit, updated_at = now()`;
  await tx`
    update billing_accounts
       set topup_seq = ${a.topupSeq + 1}, topup_attempts = 0, topup_retry_at = null, updated_at = now()
     where tenant_id = ${a.tenantId}`;
  d.log.info({ tenantId: a.tenantId, amountCents, credit: a.credit }, 'prepaid top-up charged');
  return 'charged';
}
