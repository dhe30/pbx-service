import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyBaseLogger } from 'fastify';
import { PRICES } from '../billing/catalog.js';
import { chargeProrated } from '../billing/charge.js';
import { assertCanBuy, claimPurchase, failPurchase, releaseLease } from '../billing/purchase-requests.js';
import type { StripeClient } from '../billing/stripe.js';
import { HttpError } from '../errors.js';
import { NumberUnavailable, type DidProvider, type NumberKind } from './provider.js';

// Buying a phone number (backend step 8; docs/backend-step8.md, docs/billing-flows.md §3).
//
//   1. checks: card saved + plan paid, account not past due, number not already ours;
//   2. ORDER at the DID provider and wait for the DID;
//   3. assign it to our inbound trunk (calls reach our edges);
//   4. CHARGE the number's price prorated to the end of the billing period;
//   5. insert phone_numbers (status assigned, paid_until = period end) and its account_items row
//      (renewed weekly by the billing scheduler, src/billing/scheduler.ts).
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
// Only one attempt per key runs at a time (updated_at is a short lease). The generic part of this
// lives in src/billing/purchase-requests.ts (shared with add-on purchases).

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
  kind: string;
  status: 'pending' | 'ordered' | 'completed' | 'failed';
  request: { availableNumberId: string } | null;
  providerOrderId: string | null;
  providerDidId: string | null;
  did: string | null;
  numberKind: NumberKind | null;
  incomingCostPerMin: string | null; // numeric
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

  const claimed = await claimPurchase<PurchaseRow>(sql, key, p.tenantId, 'number', request);
  if (claimed === 'busy') {
    throw new HttpError(409, 'purchase_in_progress', 'This purchase is still running; retry in a few seconds');
  }
  let row: PurchaseRow = claimed;
  if (row.status === 'completed') {
    return { status: 'completed', phoneNumberId: row.phoneNumberId!, chargedCents: row.amountCents ?? 0, replayed: true };
  }
  if (row.status === 'failed') throw new HttpError(TERMINAL[row.errorCode!] ?? 400, row.errorCode!, row.errorMessage!);

  const fail = async (code: keyof typeof TERMINAL, message: string): Promise<never> => {
    await failPurchase(sql, key, code, message);
    throw new HttpError(TERMINAL[code]!, code, message);
  };
  const save = (fields: Partial<Record<'status' | 'provider_order_id' | 'provider_did_id' | 'did' | 'number_kind' | 'incoming_cost_per_min', string | null>>) =>
    withRetry(() => sql`update purchase_requests set ${sql(fields)}, updated_at = now() where idempotency_key = ${key}`);

  try {
    const fresh = row.did === null && row.providerOrderId === null;
    if (fresh) await assertCanBuy(sql, p.tenantId, 'numbers');

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
          const cost = offer.incomingCostPerMin === null ? null : String(offer.incomingCostPerMin);
          await save({ did: offer.number, number_kind: offer.kind, incoming_cost_per_min: cost });
          row = { ...row, did: offer.number, numberKind: offer.kind, incomingCostPerMin: cost };
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
    const priceCents = numberPriceCents(kind);
    const charge = await chargeProrated(
      d,
      {
        tenantId: p.tenantId,
        chargeKey: `number:${key}`,
        priceCents,
        purpose: 'number',
        description: `${kind === 'toll_free' ? 'Toll-free number' : 'Local number'} ${row.did} (prorated)`,
      },
      now,
    );
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
          insert into phone_numbers (did, tenant_id, status, kind, provider_ref, paid_until, purchased_at, incoming_cost_per_min)
          values (${row.did!}, ${p.tenantId}, 'assigned', ${kind}, ${row.providerDidId!}, ${charge.paidUntil}, now(),
                  ${row.incomingCostPerMin})
          on conflict (did) do update
             set tenant_id = excluded.tenant_id, status = 'assigned', kind = excluded.kind,
                 provider_ref = excluded.provider_ref, paid_until = excluded.paid_until,
                 incoming_cost_per_min = excluded.incoming_cost_per_min,
                 purchased_at = excluded.purchased_at, destination = null, ivr_menu_id = null
           where phone_numbers.tenant_id is null
              or (phone_numbers.status = 'released' and coalesce(phone_numbers.paid_until, '-infinity') <= now())
          returning id`;
        if (!n) throw new Error(`purchased DID ${row.did} is already an active number in phone_numbers`);
        // The recurring item the billing scheduler renews (and stops renewing on release).
        await tx`
          insert into account_items (tenant_id, kind, phone_number_id, price_cents, paid_through)
          values (${p.tenantId}, 'number', ${n.id}, ${priceCents}, ${charge.paidUntil})`;
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
