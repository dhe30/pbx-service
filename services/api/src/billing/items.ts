import { withRetry, type Db, type Sql } from '@pbx/shared';
import type { FastifyBaseLogger } from 'fastify';
import { HttpError } from '../errors.js';
import { PRICES } from './catalog.js';
import { chargeProrated } from './charge.js';
import { assertCanBuy, claimPurchase, failPurchase, releaseLease } from './purchase-requests.js';
import type { StripeClient } from './stripe.js';

// Recurring account items (table account_items; docs/billing-flows.md §2-§3, §7): the plan, extra
// extensions, numbers and the two add-ons. This module buys and cancels the ones bought through
// /billing/items (extra extensions, international calling, call recording). Numbers are bought
// through /numbers/purchase and the plan at signup; both also have rows here.
//
// The call path never reads account_items. It reads tenant_settings, which syncSettings() derives
// from the items in the same transaction as every change:
//   intl_calling / record_calls = an active add-on (renewing, or cancelled but still paid for);
//   extra_extensions            = extension slots that still renew. A cancelled slot can't be used
//                                 for a NEW extension, so the count drops at once (cancelling is
//                                 refused while the extensions in use need it).
// A cancelled add-on stays on until its paid period ends; the billing scheduler then calls
// syncSettings() again, which turns it off (src/billing/scheduler.ts).

export type ItemKind = 'plan' | 'extension' | 'number' | 'intl_calling' | 'recording';
export const BUYABLE = ['extension', 'intl_calling', 'recording'] as const;
export type BuyableKind = (typeof BUYABLE)[number];

/** Price per 7-day period (src/billing/catalog.ts, under the course ceilings). */
export const ITEM_PRICE_CENTS: Record<BuyableKind, number> = {
  extension: PRICES.extensionCents,
  intl_calling: PRICES.intlCallingCents,
  recording: PRICES.recordingCents,
};

const LABEL: Record<ItemKind, string> = {
  plan: 'Plan',
  extension: 'Additional extension',
  number: 'Phone number',
  intl_calling: 'International calling',
  recording: 'Call recording',
};

export interface AccountItem {
  id: string;
  kind: ItemKind;
  priceCents: number;
  startedAt: Date;
  paidThrough: Date;
  removedAt: Date | null;
  renews: boolean;
  phoneNumberId: string | null;
  did: string | null;
}

const ITEM_COLUMNS = (db: Db) => db`
  i.id, i.kind, i.price_cents, i.started_at, i.paid_through, i.removed_at, i.removed_at is null as renews,
  i.phone_number_id, n.did`;

/** The account's active items: renewing, or cancelled but still in their paid period. */
export function listItems(db: Db, tenantId: string, id: string | null = null) {
  return db<AccountItem[]>`
    select ${ITEM_COLUMNS(db)}
      from account_items i left join phone_numbers n on n.id = i.phone_number_id
     where i.tenant_id = ${tenantId} and (i.removed_at is null or i.paid_through > now())
       ${id ? db`and i.id = ${id}` : db``}
     order by array_position(array['plan','extension','number','intl_calling','recording'], i.kind), i.started_at, i.id`;
}

/** Derives the tenant_settings flags the call path reads from the account's items. */
export async function syncSettings(db: Db, tenantId: string): Promise<void> {
  await db`
    insert into tenant_settings (tenant_id, intl_calling, record_calls, extra_extensions)
    values (
      ${tenantId},
      exists (select 1 from account_items
               where tenant_id = ${tenantId} and kind = 'intl_calling' and (removed_at is null or paid_through > now())),
      exists (select 1 from account_items
               where tenant_id = ${tenantId} and kind = 'recording' and (removed_at is null or paid_through > now())),
      (select count(*)::int from account_items where tenant_id = ${tenantId} and kind = 'extension' and removed_at is null))
    on conflict (tenant_id) do update
      set intl_calling = excluded.intl_calling, record_calls = excluded.record_calls,
          extra_extensions = excluded.extra_extensions
      where tenant_settings.intl_calling is distinct from excluded.intl_calling
         or tenant_settings.record_calls is distinct from excluded.record_calls
         or tenant_settings.extra_extensions is distinct from excluded.extra_extensions`;
}

interface ItemPurchaseRow {
  status: 'pending' | 'ordered' | 'completed' | 'failed';
  kind: string;
  request: { kind: BuyableKind } | null;
  accountItemId: string | null;
  amountCents: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

/** Terminal failures, replayed to retries with the same key. */
const TERMINAL: Record<string, number> = { payment_failed: 402, already_active: 409 };

export interface BuyResult {
  itemId: string;
  chargedCents: number;
  replayed: boolean;
}

/**
 * Buys an extra extension slot or an add-on: prorated charge, then the item (and the flag the call
 * path reads), idempotent per Idempotency-Key like number purchases.
 *
 * Buying an add-on that was cancelled but is still paid for resumes it (no charge). Buying one
 * that already renews is 409 already_active. The account's settings row is locked for the whole
 * purchase (including the card charge), so two concurrent purchases of the same add-on with
 * different keys can't both charge.
 */
export async function buyItem(
  d: { sql: Sql; stripe: StripeClient; log: FastifyBaseLogger },
  p: { tenantId: string; clientKey: string; kind: BuyableKind },
  now = new Date(),
): Promise<BuyResult> {
  const { sql } = d;
  const key = `${p.tenantId}:${p.clientKey}`;
  const claimed = await claimPurchase<ItemPurchaseRow>(sql, key, p.tenantId, 'item', { kind: p.kind });
  if (claimed === 'busy') throw new HttpError(409, 'purchase_in_progress', 'This purchase is still running; retry in a few seconds');
  if (claimed.status === 'completed') {
    return { itemId: claimed.accountItemId!, chargedCents: claimed.amountCents ?? 0, replayed: true };
  }
  if (claimed.status === 'failed') throw new HttpError(TERMINAL[claimed.errorCode!] ?? 400, claimed.errorCode!, claimed.errorMessage!);

  const chargeKey = `item:${key}`;
  try {
    const outcome = await withRetry(() =>
      sql.begin(async (tx) => {
        await tx`
          insert into tenant_settings (tenant_id) values (${p.tenantId}) on conflict (tenant_id) do nothing`;
        await tx`select 1 from tenant_settings where tenant_id = ${p.tenantId} for update`;

        // A charge that already went through (an earlier attempt died after it) is finished, never
        // re-checked: the customer paid.
        const [paid] = await tx`select 1 from payments where idempotency_key = ${chargeKey} and status = 'succeeded'`;
        if (!paid) {
          await assertCanBuy(tx, p.tenantId, 'add-ons');
          if (p.kind !== 'extension') {
            const [existing] = await tx<{ id: string; renews: boolean }[]>`
              select id, removed_at is null as renews from account_items
               where tenant_id = ${p.tenantId} and kind = ${p.kind} and (removed_at is null or paid_through > now())
               order by removed_at is null desc limit 1`;
            if (existing?.renews) return { ok: false as const, code: 'already_active', message: `${LABEL[p.kind]} is already active` };
            if (existing) {
              // Cancelled but still paid for: renew it again, nothing to charge now.
              await tx`update account_items set removed_at = null where id = ${existing.id}`;
              await syncSettings(tx, p.tenantId);
              await completePurchase(tx, key, existing.id, 0);
              return { ok: true as const, itemId: existing.id, cents: 0 };
            }
          }
        }

        const charge = await chargeProrated(
          { sql: tx, stripe: d.stripe },
          { tenantId: p.tenantId, chargeKey, priceCents: ITEM_PRICE_CENTS[p.kind], purpose: p.kind, description: `${LABEL[p.kind]} (prorated)` },
          now,
        );
        if (!charge.ok) return { ok: false as const, code: 'payment_failed', message: `The card was declined: ${charge.message}. Nothing was bought.` };
        const [item] = await tx<{ id: string }[]>`
          insert into account_items (tenant_id, kind, price_cents, paid_through)
          values (${p.tenantId}, ${p.kind}, ${ITEM_PRICE_CENTS[p.kind]}, ${charge.paidUntil})
          returning id`;
        await syncSettings(tx, p.tenantId);
        await completePurchase(tx, key, item!.id, charge.cents);
        return { ok: true as const, itemId: item!.id, cents: charge.cents };
      }),
    );
    if (!outcome.ok) {
      await failPurchase(sql, key, outcome.code, outcome.message);
      throw new HttpError(TERMINAL[outcome.code]!, outcome.code, outcome.message);
    }
    d.log.info({ tenantId: p.tenantId, kind: p.kind, chargedCents: outcome.cents }, 'account item bought');
    return { itemId: outcome.itemId, chargedCents: outcome.cents, replayed: false };
  } catch (err) {
    if (!(err instanceof HttpError && TERMINAL[err.code])) await releaseLease(sql, key).catch(() => {});
    throw err;
  }
}

const completePurchase = (db: Db, key: string, itemId: string, cents: number) =>
  db`
    update purchase_requests
       set status = 'completed', account_item_id = ${itemId}, amount_cents = ${cents}, updated_at = now()
     where idempotency_key = ${key}`;

/**
 * Cancels an item: it keeps working until paid_through and is not renewed. Numbers are released
 * with DELETE /numbers/:id (provider side too), and the plan can't be cancelled.
 */
export async function cancelItem(sql: Sql, tenantId: string, id: string): Promise<AccountItem> {
  return withRetry(() =>
    sql.begin(async (tx) => {
      await tx`insert into tenant_settings (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`;
      await tx`select 1 from tenant_settings where tenant_id = ${tenantId} for update`;
      const [item] = await tx<{ kind: ItemKind; removedAt: Date | null }[]>`
        select kind, removed_at from account_items
         where id = ${id} and tenant_id = ${tenantId} and (removed_at is null or paid_through > now())
         for update`;
      if (!item) throw new HttpError(404, 'not_found', 'No such item');
      if (item.kind === 'plan') throw new HttpError(400, 'invalid_request', 'The plan cannot be cancelled');
      if (item.kind === 'number') throw new HttpError(400, 'invalid_request', 'Release numbers with DELETE /numbers/{id}');
      if (item.removedAt === null) {
        if (item.kind === 'extension') {
          // The slot stops counting at once, so the extensions in use must fit without it.
          const [{ used, allowedAfter }] = (await tx`
            select (select count(*)::int from extensions where tenant_id = ${tenantId}) as used,
                   ts.included_extensions + ts.extra_extensions - 1 as allowed_after
              from tenant_settings ts where ts.tenant_id = ${tenantId}`) as unknown as [{ used: number; allowedAfter: number }];
          if (used > allowedAfter) {
            throw new HttpError(
              409,
              'extension_limit',
              `${used} extensions are in use and only ${allowedAfter} would remain; delete an extension first`,
            );
          }
        }
        await tx`update account_items set removed_at = now() where id = ${id}`;
        await syncSettings(tx, tenantId);
      }
      const [row] = await listItems(tx, tenantId, id);
      return row!;
    }),
  );
}
