import { withRetry, type Db, type Sql } from '@pbx/shared';
import { HttpError } from '../errors.js';

// Idempotent, resumable purchases (number purchases: src/numbers/purchase.ts; plan add-ons and
// extra extensions: src/billing/items.ts). The client's Idempotency-Key identifies one purchase in
// `purchase_requests` (scoped per tenant: the stored key is "<tenant_id>:<client key>"). A retry
// with the same key continues where the last attempt stopped, replays the result of a finished
// one, and never orders or charges twice. `updated_at` doubles as a short lease so only one
// attempt per key runs at a time.

export const LEASE_SEC = 30;

/** Idempotency-Key header: any client-chosen string, e.g. a UUID per purchase attempt. */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

export type PurchaseKind = 'number' | 'item';

/** Stable JSON for comparing requests (jsonb reorders object keys). */
const canonical = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`;

/**
 * Creates the purchase row, or takes over an existing one. 'busy' = another attempt with this key
 * is running right now. 409 idempotency_key_reused if the key was used for a different request.
 */
export async function claimPurchase<R extends { status: string; kind: string; request: unknown }>(
  sql: Sql,
  key: string,
  tenantId: string,
  kind: PurchaseKind,
  request: Record<string, unknown>,
): Promise<R | 'busy'> {
  return withRetry(async () => {
    const inserted = await sql<R[]>`
      insert into purchase_requests (idempotency_key, tenant_id, status, kind, request)
      values (${key}, ${tenantId}, 'pending', ${kind}, ${sql.json(request as never)})
      on conflict (idempotency_key) do nothing
      returning *`;
    if (inserted[0]) return inserted[0];

    const [row] = await sql<R[]>`select * from purchase_requests where idempotency_key = ${key}`;
    if (!row) throw new Error('purchase request vanished');
    if (row.kind !== kind || canonical(row.request) !== canonical(request)) {
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'This Idempotency-Key was already used for a different purchase; use a new key for a new purchase',
      );
    }
    if (row.status === 'completed' || row.status === 'failed') return row;
    // In progress: take it over only if the last attempt let go of it (or died).
    const [taken] = await sql<R[]>`
      update purchase_requests set updated_at = now()
       where idempotency_key = ${key} and status in ('pending', 'ordered')
         and updated_at < now() - make_interval(secs => ${LEASE_SEC})
      returning *`;
    return taken ?? 'busy';
  });
}

/** Lets the next retry with this key start right away (after a retryable failure). */
export const releaseLease = (sql: Sql, key: string) =>
  withRetry(() => sql`update purchase_requests set updated_at = '-infinity' where idempotency_key = ${key} and status in ('pending', 'ordered')`);

/** Records a terminal failure (replayed to every retry with the same key). */
export const failPurchase = (sql: Sql, key: string, code: string, message: string) =>
  withRetry(
    () => sql`
      update purchase_requests set status = 'failed', error_code = ${code}, error_message = ${message}, updated_at = now()
       where idempotency_key = ${key}`,
  );

/** 402 unless the account has a card, a paid plan and isn't past due. */
export async function assertCanBuy(sql: Db, tenantId: string, what: string): Promise<void> {
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
    throw new HttpError(402, 'payment_required', `The account is past due; pay the open invoice before buying ${what}`);
  }
}
