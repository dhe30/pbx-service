import { billingPeriod, withRetry, type Sql } from '@pbx/shared';
import type { FastifyBaseLogger } from 'fastify';
import { MIN_CHARGE_CENTS, PRICES, proratedCents } from '../billing/catalog.js';
import type { StripeClient } from '../billing/stripe.js';
import { HttpError } from '../errors.js';
import { NumberUnavailable, type DidProvider, type NumberKind } from './provider.js';

// Buying a phone number (backend step 8; docs/backend-step8.md, docs/billing-flows.md §3).
//
//   1. checks: card saved + plan paid, account not past due, number not already ours;
//   2. ORDER at the DID provider and wait for the DID;
//   3. assign it to our inbound trunk (calls reach our edges);
//   4. CHARGE the number's price prorated to the end of the billing period;
//   5. insert phone_numbers (status assigned, paid_until = period end).
//
// Order first, charge second (billing-flows §8.1): the payment gateway has no refunds, so charging
// first and then failing the order would keep the customer's money for nothing. If the charge is
// declined, the DID is released again at the provider (we lose at most its setup fee).
//
// Idempotent and resumable: the client's Idempotency-Key identifies the purchase
// (purchase_requests, per tenant). Each step stores its result before the next one starts, so a
// retry with the same key (after a timeout, a 502, a crash, or a 202 "still processing")
// continues where the last attempt stopped and never orders or charges twice:
//   - the provider order id is stored right after ordering; if the process died before that,
//     findOwnedDid(number) finds the DID we already got;
//   - the charge's Stripe Idempotency-Key is derived from the purchase key;
//   - a completed purchase replays its result; a failed one replays its error.
// Only one attempt per key runs at a time (updated_at is a short lease).

const LEASE_SEC = 30;

export const numberPriceCents = (kind: NumberKind) => (kind === 'toll_free' ? PRICES.tollFreeNumberCents : PRICES.localNumberCents);

export interface PurchaseDeps {
  sql: Sql;
  stripe: StripeClient;
  provider: DidProvider;
  log: FastifyBaseLogger;
}

export type PurchaseResult =
  | { status: 'completed'; phoneNumberId: string; chargedCents: number; replayed: boolean }
  /** The provider is still processing the order: retry with the same Idempotency-Key. */
  | { status: 'processing' };

interface PurchaseRow {
  idempotencyKey: string;
  tenantId: string;
  status: 'pending' | 'ordered' | 'completed' | 'failed';
  request: { availableNumberId: string } | null;
  providerOrderId: string | null;
  providerDidId: string | null;
  did: string | null;
  numberKind: NumberKind | null;
  phoneNumberId: string | null;
  amountCents: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Terminal failures, replayed to retries with the same key. Anything else may be retried. */
const TERMINAL: Record<string, number> = { number_unavailable: 409, payment_failed: 402 };

export async function purchaseNumber(
  d: PurchaseDeps,
  p: { tenantId: string; clientKey: string; availableNumberId: string },
  now = new Date(),
): Promise<PurchaseResult> {
  const { sql } = d;
  const key = `${p.tenantId}:${p.clientKey}`;
  const request = { availableNumberId: p.availableNumberId };

  const claimed = await claim(sql, key, p.tenantId, request);
  if (claimed === 'busy') {
    throw new HttpError(409, 'purchase_in_progress', 'This purchase is still running; retry in a few seconds');
  }
  let row: PurchaseRow = claimed;
  if (row.status === 'completed') {
    return { status: 'completed', phoneNumberId: row.phoneNumberId!, chargedCents: row.amountCents ?? 0, replayed: true };
  }
  if (row.status === 'failed') throw new HttpError(TERMINAL[row.errorCode!] ?? 400, row.errorCode!, row.errorMessage!);

  const fail = async (code: keyof typeof TERMINAL, message: string): Promise<never> => {
    await withRetry(
      () => sql`
        update purchase_requests set status = 'failed', error_code = ${code}, error_message = ${message}, updated_at = now()
         where idempotency_key = ${key}`,
    );
    throw new HttpError(TERMINAL[code]!, code, message);
  };
  const save = (fields: Partial<Record<'status' | 'provider_order_id' | 'provider_did_id' | 'did' | 'number_kind', string>>) =>
    withRetry(() => sql`update purchase_requests set ${sql(fields)}, updated_at = now() where idempotency_key = ${key}`);

  try {
    const fresh = row.did === null && row.providerOrderId === null;
    if (fresh) await assertCanBuy(sql, p.tenantId);

    // ---- 2. order ------------------------------------------------------------------------------
    if (row.providerDidId === null) {
      let didOf: { id: string; number: string } | null = null;
      if (row.providerOrderId) {
        didOf = (await d.provider.getOrder(row.providerOrderId)).did;
      } else {
        // Interrupted after ordering but before storing the order id? Then the DID is already ours.
        if (row.did) didOf = await d.provider.findOwnedDid(row.did);
        if (!didOf) {
          const offer = await d.provider.getAvailable(p.availableNumberId);
          if (!offer) return await fail('number_unavailable', 'That number is no longer available; search again');
          if (await isOurs(sql, offer.number)) return await fail('number_unavailable', 'That number is already in use');
          await save({ did: offer.number, number_kind: offer.kind });
          row = { ...row, did: offer.number, numberKind: offer.kind };
          let ordered;
          try {
            ordered = await d.provider.order(offer);
          } catch (err) {
            if (err instanceof NumberUnavailable) return await fail('number_unavailable', 'That number was just taken; search again');
            throw err;
          }
          await save({ provider_order_id: ordered.orderId });
          didOf = ordered.did;
        }
      }
      if (!didOf) {
        await releaseLease(sql, key);
        return { status: 'processing' };
      }
      await save({ status: 'ordered', provider_did_id: didOf.id, did: didOf.number });
      row = { ...row, status: 'ordered', providerDidId: didOf.id, did: didOf.number };
      d.log.info({ tenantId: p.tenantId, did: didOf.number }, 'number ordered');
    }

    // ---- 3. route the DID to us (idempotent, so simply repeated on a resume) ---------------------
    await d.provider.assignToTrunk(row.providerDidId!);

    // ---- 4. charge -------------------------------------------------------------------------------
    const kind = row.numberKind ?? 'local';
    const charge = await chargeNumber(d, p.tenantId, key, row.did!, kind, now);
    if (!charge.ok) {
      // Give the number back so it doesn't renew at our expense. If that fails too, log it: the
      // DID would need releasing by hand (it is not in phone_numbers).
      await d.provider.release(row.providerDidId!).catch((err: unknown) =>
        d.log.error({ err, did: row.did, didId: row.providerDidId }, 'could not release DID after a declined charge'),
      );
      return await fail('payment_failed', `The card was declined: ${charge.message}. The number was not bought.`);
    }

    // ---- 5. the number is the tenant's ---------------------------------------------------------
    const phoneNumberId = await withRetry(() =>
      sql.begin(async (tx) => {
        const [n] = await tx<{ id: string }[]>`
          insert into phone_numbers (did, tenant_id, status, kind, provider_ref, paid_until, purchased_at)
          values (${row.did!}, ${p.tenantId}, 'assigned', ${kind}, ${row.providerDidId!}, ${charge.paidUntil}, now())
          on conflict (did) do update
             set tenant_id = excluded.tenant_id, status = 'assigned', kind = excluded.kind,
                 provider_ref = excluded.provider_ref, paid_until = excluded.paid_until,
                 purchased_at = excluded.purchased_at, destination = null, ivr_menu_id = null
           where phone_numbers.tenant_id is null
              or (phone_numbers.status = 'released' and coalesce(phone_numbers.paid_until, '-infinity') <= now())
          returning id`;
        if (!n) throw new Error(`purchased DID ${row.did} is already an active number in phone_numbers`);
        await tx`
          update purchase_requests
             set status = 'completed', phone_number_id = ${n.id}, amount_cents = ${charge.cents}, updated_at = now()
           where idempotency_key = ${key}`;
        return n.id;
      }),
    );
    d.log.info({ tenantId: p.tenantId, did: row.did, chargedCents: charge.cents }, 'number purchased');
    return { status: 'completed', phoneNumberId, chargedCents: charge.cents, replayed: false };
  } catch (err) {
    // Not terminal (provider / gateway / DB trouble, or a 402 before ordering): let the client's
    // retry start right away instead of waiting for the lease to expire.
    if (!(err instanceof HttpError && TERMINAL[err.code])) await releaseLease(sql, key).catch(() => {});
    throw err;
  }
}

/**
 * Creates the purchase row, or takes over an existing one. 'busy' = another attempt with this key
 * is running right now.
 */
async function claim(sql: Sql, key: string, tenantId: string, request: { availableNumberId: string }): Promise<PurchaseRow | 'busy'> {
  return withRetry(async () => {
    const inserted = await sql<PurchaseRow[]>`
      insert into purchase_requests (idempotency_key, tenant_id, status, kind, request)
      values (${key}, ${tenantId}, 'pending', 'number', ${sql.json(request)})
      on conflict (idempotency_key) do nothing
      returning *`;
    if (inserted[0]) return inserted[0];

    const [row] = await sql<PurchaseRow[]>`select * from purchase_requests where idempotency_key = ${key}`;
    if (!row) throw new Error('purchase request vanished');
    if (row.request?.availableNumberId !== request.availableNumberId) {
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different purchase; use a new key for a new purchase',
      );
    }
    if (row.status === 'completed' || row.status === 'failed') return row;
    // In progress: take it over only if the last attempt let go of it (or died).
    const [taken] = await sql<PurchaseRow[]>`
      update purchase_requests set updated_at = now()
       where idempotency_key = ${key} and status in ('pending', 'ordered')
         and updated_at < now() - make_interval(secs => ${LEASE_SEC})
      returning *`;
    return taken ?? 'busy';
  });
}

const releaseLease = (sql: Sql, key: string) =>
  withRetry(() => sql`update purchase_requests set updated_at = '-infinity' where idempotency_key = ${key} and status in ('pending', 'ordered')`);

/** 402 unless the account has a card, a paid plan and isn't past due. */
async function assertCanBuy(sql: Sql, tenantId: string): Promise<void> {
  const [a] = await withRetry(
    () => sql<{ status: string; paymentMethodId: string | null; planPaidThrough: Date | null }[]>`
      select t.status, ba.payment_method_id, ba.plan_paid_through
        from tenants t left join billing_accounts ba on ba.tenant_id = t.id
       where t.id = ${tenantId}`,
  );
  if (!a?.paymentMethodId || !a.planPaidThrough) {
    throw new HttpError(402, 'payment_required', 'Save a card and pay the plan first (POST /billing/card)');
  }
  if (a.status === 'past_due') {
    throw new HttpError(402, 'payment_required', 'The account is past due; pay the open invoice before buying numbers');
  }
}

/** Is the number already one of ours (another account's, or released but still in a paid period)? */
async function isOurs(sql: Sql, did: string): Promise<boolean> {
  const rows = await withRetry(
    () => sql`
      select 1 from phone_numbers
       where did = ${did} and tenant_id is not null
         and (status = 'assigned' or coalesce(paid_until, '-infinity') > now())`,
  );
  return rows.length > 0;
}

type ChargeOutcome = { ok: true; cents: number; paidUntil: Date } | { ok: false; message: string };

/** Charges the number's price prorated to the end of the current period (billing-flows §3). */
async function chargeNumber(d: PurchaseDeps, tenantId: string, key: string, did: string, kind: NumberKind, now: Date): Promise<ChargeOutcome> {
  const { sql } = d;
  const [acct] = await withRetry(
    () => sql<{ timezone: string; createdAt: Date; stripeCustomerId: string; paymentMethodId: string | null }[]>`
      select t.timezone, t.created_at, ba.stripe_customer_id, ba.payment_method_id
        from tenants t join billing_accounts ba on ba.tenant_id = t.id
       where t.id = ${tenantId}`,
  );
  if (!acct?.paymentMethodId) return { ok: false, message: 'no saved card' };
  const period = billingPeriod(acct.timezone, acct.createdAt, now);
  const chargeKey = `number:${key}`;

  // Already charged by an earlier attempt? (Stripe would replay it anyway; this skips the call.)
  const [prev] = await withRetry(
    () => sql<{ status: string; amountCents: number }[]>`
      select status, amount_cents from payments where idempotency_key = ${chargeKey}`,
  );
  if (prev?.status === 'succeeded') return { ok: true, cents: prev.amountCents, paidUntil: period.end };

  const cents = proratedCents(numberPriceCents(kind), period, now);
  const record = (status: 'succeeded' | 'failed', paymentIntentId: string | null, message: string | null, amount: number) =>
    withRetry(
      () => sql`
        insert into payments (tenant_id, purpose, period_start, idempotency_key, amount_cents,
                              stripe_payment_intent_id, status, failure_message)
        values (${tenantId}, 'number', ${period.startDate}, ${chargeKey}, ${amount}, ${paymentIntentId}, ${status}, ${message})
        on conflict (idempotency_key) do update
          set status = excluded.status, stripe_payment_intent_id = excluded.stripe_payment_intent_id,
              failure_message = excluded.failure_message`,
    );

  if (cents < MIN_CHARGE_CENTS) {
    await record('succeeded', null, 'below minimum charge, waived', 0);
    return { ok: true, cents: 0, paidUntil: period.end };
  }
  const label = kind === 'toll_free' ? 'Toll-free number' : 'Local number';
  const result = await d.stripe.charge(
    { customerId: acct.stripeCustomerId, paymentMethodId: acct.paymentMethodId, amountCents: cents, description: `${label} ${did} (prorated)`, tenantId },
    chargeKey,
  );
  if (!result.ok) {
    await record('failed', result.paymentIntentId, result.message, cents);
    return { ok: false, message: result.message };
  }
  await record('succeeded', result.paymentIntentId, null, cents);
  return { ok: true, cents, paidUntil: period.end };
}
