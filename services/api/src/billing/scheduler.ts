import { billingPeriod, withRetry, type Db, type Sql } from '@pbx/shared';
import type { FastifyBaseLogger } from 'fastify';
import { cleanupOrphanVoicemailMedia } from '../maintenance.js';
import type { MediaStore } from '../object-store.js';
import { MIN_CHARGE_CENTS, altPricingEnabled, callPricingAt, inAltWindow, planAt, pricesAt } from './catalog.js';
import { rechargeNext } from './credit.js';
import { syncSettings } from './items.js';
import type { StripeClient } from './stripe.js';

// Billing scheduler (course spec §5; docs/billing-flows.md §4-§5). Runs in every API process every
// BILLING_TICK_SEC; each unit of work is claimed with FOR UPDATE SKIP LOCKED, so several app nodes
// can run it at once without double work and without a leader.
//
// One tick:
//   1. invoice: for every account whose plan's paid period has ended, create the invoice for the
//      new period: a recurring line per renewing item (plan, extra extensions, numbers, add-ons;
//      each item's paid_through moves to the new period end), a usage line per charged call leg
//      of the ended period (cdrs.charge > 0), and the included minutes used. Cancelled items whose
//      period ended are not renewed (DIDWW stops renewing released numbers on its own).
//   2. charge: every open/failed invoice whose next attempt is due, off-session on the saved card;
//      a decline is retried with backoff (5 min, 15 min, 1 h, 3 h, then every 6 h).
//   3. past due: accounts with an invoice still unpaid 24 h after its period ended. The call path
//      then blocks outgoing external legs (tenants.status, NOTIFY pbx_config).
//   4. lapse: add-ons whose cancelled period ended are switched off (tenant_settings).
//   5. housekeeping (with a store): voicemail audio left behind by *98 deletes (src/maintenance.ts).
//   6. prepaid top-ups: every account whose credit is below its threshold gets one top-up charged
//      (credit.ts). Runs first, so a new account's credit is charged within one tick.
// Prepaid usage: calls started at or after tenants.prepaid_since are deducted from the
// credit balance, not invoiced; the invoice shows the credit charged and the usage deducted.
// A paid invoice reactivates a past-due account once nothing else is unpaid. Adding a card charges
// every unpaid invoice at once (payOverdue, called from POST /billing/card).

export interface BillingDeps {
  sql: Sql;
  stripe: StripeClient;
  log: FastifyBaseLogger;
  /** Object store for housekeeping; without it that step is skipped. */
  store?: MediaStore;
}

/** Retry delays after a failed charge attempt (attempt 1, 2, ...), then the last one repeats. */
export const RETRY_DELAYS_SEC = [5 * 60, 15 * 60, 3600, 3 * 3600, 6 * 3600];
/** How long after the ended period an unpaid invoice makes the account past due. */
export const PAST_DUE_AFTER_SEC = 24 * 3600;
/** Work per step and tick (the rest waits for the next tick). */
const BATCH = 200;

export interface TickResult {
  invoiced: number;
  charged: number;
  failed: number;
  pastDue: number;
  lapsed: number;
  orphansDeleted: number;
  toppedUp: number;
  topUpsFailed: number;
}

/**
 * Per-minute prices (catalog.ts): sets the call_pricing row to the list in force at
 * `now`. Writes only when it differs, so the call_pricing_notify reload fires twice a day, not
 * every tick; every API process may run it, they all write the same values. Off with
 * ALT_PRICING=off (the row then keeps what the migrations set).
 */
export async function applyCallPricing(sql: Sql, now = new Date()): Promise<boolean> {
  if (!altPricingEnabled()) return false;
  const p = callPricingAt(now);
  const changed = await sql`
    update call_pricing
       set us_per_min = ${p.usPerMin}, toll_free_in_per_min = ${p.tollFreeInPerMin}, intl_multiplier = ${p.intlMultiplier}
     where (us_per_min, toll_free_in_per_min, intl_multiplier)
           is distinct from (${p.usPerMin}::numeric, ${p.tollFreeInPerMin}::numeric, ${p.intlMultiplier}::numeric)
    returning 1`;
  return changed.length > 0;
}

export async function runBillingTick(d: BillingDeps, now = new Date()): Promise<TickResult> {
  const r: TickResult = { invoiced: 0, charged: 0, failed: 0, pastDue: 0, lapsed: 0, orphansDeleted: 0, toppedUp: 0, topUpsFailed: 0 };
  // First, and on its own: a failure here must not stop billing.
  try {
    if (await applyCallPricing(d.sql, now)) d.log.info({ alt: inAltWindow(now), ...callPricingAt(now) }, 'per-minute prices switched');
  } catch (err) {
    d.log.error({ err }, 'per-minute price switch failed');
  }
  for (let i = 0; i < BATCH; i++) {
    const outcome = await rechargeNext(d, now);
    if (outcome === null) break;
    if (outcome === 'charged') r.toppedUp++;
    else r.topUpsFailed++;
  }
  r.lapsed = await expireLapsedAddons(d, now);
  for (let i = 0; i < BATCH && (await invoiceNextAccount(d, now)); i++) r.invoiced++;
  for (let i = 0; i < BATCH; i++) {
    const outcome = await chargeNextInvoice(d, now);
    if (outcome === null) break;
    if (outcome) r.charged++;
    else r.failed++;
  }
  r.pastDue = await markPastDue(d, now);
  if (d.store) {
    r.orphansDeleted = await cleanupOrphanVoicemailMedia({ sql: d.sql, store: d.store, log: d.log }, now);
  }
  if (r.invoiced || r.charged || r.failed || r.pastDue || r.lapsed || r.toppedUp || r.topUpsFailed) d.log.info({ ...r }, 'billing tick');
  return r;
}

/** Runs runBillingTick every `intervalMs` (never two at once). Returns a stop function. */
export function startBillingScheduler(d: BillingDeps, intervalMs: number): () => Promise<void> {
  let running: Promise<unknown> | null = null;
  const tick = () => {
    if (running) return;
    running = runBillingTick(d)
      .catch((err: unknown) => d.log.error({ err }, 'billing tick failed'))
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, Math.min(intervalMs, 10_000));
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return async () => {
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}

// ---- 1. invoices --------------------------------------------------------------------------------

/** Invoices one account whose plan period ended. false = nothing (left) to do. */
async function invoiceNextAccount(d: BillingDeps, now: Date): Promise<boolean> {
  return withRetry(() =>
    d.sql.begin(async (tx) => {
      const [plan] = await tx<{ id: string; tenantId: string; paidThrough: Date; timezone: string; createdAt: Date }[]>`
        select i.id, i.tenant_id, i.paid_through, t.timezone, t.created_at
          from account_items i join tenants t on t.id = i.tenant_id
         where i.kind = 'plan' and i.removed_at is null and i.paid_through <= ${now}
         order by i.paid_through
         limit 1
           for update of i skip locked`;
      if (!plan) return false;
      // The new period starts where the paid one ended (a local-midnight boundary).
      const next = billingPeriod(plan.timezone, plan.createdAt, new Date(plan.paidThrough.getTime() + 1000));
      const ended = billingPeriod(plan.timezone, plan.createdAt, new Date(next.start.getTime() - 1000));
      await createInvoice(tx, plan.tenantId, next, ended, now);
      return true;
    }),
  );
}

type Period = ReturnType<typeof billingPeriod>;

/** The list price at `now` of an account item kind (null: not a list item). */
export function listPriceCents(kind: string, numberKind: string | null, now: Date): number | null {
  const p = pricesAt(now);
  switch (kind) {
    case 'plan':
      return planAt(now).priceCents;
    case 'extension':
      return p.extensionCents;
    case 'intl_calling':
      return p.intlCallingCents;
    case 'recording':
      return p.recordingCents;
    case 'number':
      return numberKind === 'toll_free' ? p.tollFreeNumberCents : p.localNumberCents;
    default:
      return null;
  }
}

async function createInvoice(tx: Db, tenantId: string, next: Period, ended: Period, now: Date): Promise<void> {
  const [inv] = await tx<{ id: string }[]>`
    insert into invoices (tenant_id, period_start, period_start_at, period_end_at, usage_from, usage_to,
                          recurring_cents, usage_cents, total_cents, due_at, next_attempt_at)
    values (${tenantId}, ${next.startDate}, ${next.start}, ${next.end}, ${ended.start}, ${ended.end},
            0, 0, 0, ${new Date(ended.end.getTime() + PAST_DUE_AFTER_SEC * 1000)}, ${now})
    on conflict (tenant_id, period_start) do nothing
    returning id`;

  await dropUnusedItems(tx, tenantId, next, now);

  // Renew every item that renews and is paid only up to the new period's start. The invoice and
  // the renewals commit together, so an existing invoice for this period (inv undefined) only
  // happens after manual edits: the items still move on (or this account would be picked again
  // forever), but nothing is billed twice.
  const locked = await tx<{ id: string; kind: string; priceCents: number; phoneNumberId: string | null; did: string | null; numberKind: string | null }[]>`
    update account_items i set paid_through = ${next.end}
      from (select a.id, n.did, n.kind as number_kind from account_items a left join phone_numbers n on n.id = a.phone_number_id
             where a.tenant_id = ${tenantId} and a.removed_at is null and a.paid_through <= ${next.start}
             for update of a) r
     where i.id = r.id
    returning i.id, i.kind, i.price_cents, i.phone_number_id, r.did, r.number_kind`;
  // A renewal never costs more than the list in force right now (catalog.ts): the item keeps its
  // own price otherwise.
  const renewed = locked.map((r) => ({ ...r, priceCents: Math.min(r.priceCents, listPriceCents(r.kind, r.numberKind, now) ?? r.priceCents) }));
  const numberIds = renewed.filter((r) => r.phoneNumberId).map((r) => r.phoneNumberId!);
  if (numberIds.length) {
    await tx`update phone_numbers set paid_until = ${next.end} where id = any(${numberIds}::uuid[]) and status = 'assigned'`;
  }
  if (renewed.some((r) => r.kind === 'plan')) {
    await tx`update billing_accounts set plan_paid_through = ${next.end}, updated_at = now() where tenant_id = ${tenantId}`;
  }
  if (!inv) return;

  if (renewed.length) {
    await tx`
      insert into invoice_lines ${tx(
        renewed.map((r) => ({
          invoice_id: inv.id,
          kind: 'recurring',
          description: describeItem(r.kind, r.did),
          account_item_id: r.id,
          item_kind: r.kind,
          amount: (r.priceCents / 100).toFixed(2),
        })),
      )}`;
  }
  // Prepaid usage: calls started at or after prepaid_since were deducted from the credit
  // balance as they ended, so only earlier (postpaid) calls are invoiced and charged here.
  const [t] = await tx<{ prepaidSince: Date | null }[]>`select prepaid_since from tenants where id = ${tenantId}`;
  const prepaidSince = t?.prepaidSince ?? null;
  const postpaidUntil = prepaidSince && prepaidSince < ended.end ? prepaidSince : ended.end;

  // One usage line per charged leg of the ended period (outgoing beyond the included minutes,
  // international, incoming toll-free, every external leg).
  await tx`
    insert into invoice_lines (invoice_id, kind, description, cdr_id, call_id, started_at, billable_sec, amount)
    select ${inv.id}, 'usage',
           case when c.direction = 'incoming'
                then 'Incoming toll-free call from ' || coalesce(c.from_number, 'unknown caller') || ' to ' || coalesce(c.did, '')
                else 'Call to ' || coalesce(c.to_number, 'unknown') ||
                     case when c.parent_id is not null then ' (forwarded / transferred leg)' else '' end
           end || ', ' || c.billable_sec || ' s billed',
           c.id, c.call_id, c.started_at, c.billable_sec, c.charge
      from cdrs c
     where c.tenant_id = ${tenantId} and c.started_at >= ${ended.start} and c.started_at < ${postpaidUntil} and c.charge > 0`;

  // Shown on the invoice, not charged by it: the credit bought during the ended period and the
  // prepaid usage deducted from it.
  const [credit] = await tx<{ chargedCents: number; deductedCents: number }[]>`
    select coalesce((select sum(amount_cents) from payments
                      where tenant_id = ${tenantId} and purpose = 'topup' and status = 'succeeded'
                        and created_at >= ${ended.start} and created_at < ${ended.end}), 0)::int as charged_cents,
           coalesce((select round(sum(charge) * 100) from cdrs
                      where tenant_id = ${tenantId} and charge > 0
                        and started_at >= ${prepaidSince && prepaidSince > ended.start ? prepaidSince : ended.start}
                        and started_at < ${ended.end}
                        and ${prepaidSince !== null}), 0)::int as deducted_cents`;

  const recurringCents = renewed.reduce((sum, r) => sum + r.priceCents, 0);
  await tx`
    update invoices v
       set recurring_cents = ${recurringCents},
           usage_cents = u.cents,
           total_cents = ${recurringCents} + u.cents,
           credit_charged_cents = ${credit?.chargedCents ?? 0},
           usage_deducted_cents = ${credit?.deductedCents ?? 0},
           included_sec_used = coalesce((select included_sec_used from usage_periods
                                          where tenant_id = ${tenantId} and period_start = ${ended.startDate}), 0)
      from (select coalesce(round(sum(amount) * 100), 0)::int as cents
              from invoice_lines where invoice_id = ${inv.id} and kind = 'usage') u
     where v.id = ${inv.id}`;
}

/**
 * Before renewing, stop what the account no longer uses, so a renewal never bills for nothing:
 * - extra extension slots beyond (extensions - included): the newest are cancelled;
 * - an account with no extension and no number left (setup never finished, or everything was
 *   released) renews nothing at all, plan included.
 * Cancelled items keep their paid period (removed_at only stops the renewal), and the
 * extension limit follows (syncSettings recounts extra_extensions).
 */
async function dropUnusedItems(tx: Db, tenantId: string, next: Period, now: Date): Promise<void> {
  const [use] = await tx<{ exts: number; numbers: number; included: number }[]>`
    select (select count(*)::int from extensions where tenant_id = ${tenantId}) as exts,
           (select count(*)::int from phone_numbers where tenant_id = ${tenantId} and status = 'assigned') as numbers,
           coalesce((select included_extensions from tenant_settings where tenant_id = ${tenantId}), 0) as included`;
  if (!use) return;
  if (use.exts === 0 && use.numbers === 0) {
    await tx`
      update account_items set removed_at = ${now}
       where tenant_id = ${tenantId} and removed_at is null and paid_through <= ${next.start}`;
  } else {
    await tx`
      update account_items set removed_at = ${now}
       where id in (select id from account_items
                     where tenant_id = ${tenantId} and kind = 'extension' and removed_at is null
                     order by started_at, id
                    offset ${Math.max(0, use.exts - use.included)})`;
  }
  await syncSettings(tx, tenantId, now);
}

const ITEM_LABEL: Record<string, string> = {
  plan: 'Plan',
  extension: 'Additional extension',
  number: 'Phone number',
  intl_calling: 'International calling',
  recording: 'Call recording',
};
const describeItem = (kind: string, did: string | null) => (did ? `${ITEM_LABEL[kind] ?? kind} ${did}` : (ITEM_LABEL[kind] ?? kind));

// ---- 2. charging --------------------------------------------------------------------------------

interface InvoiceToCharge {
  id: string;
  tenantId: string;
  totalCents: number;
  attempts: number;
  periodStart: string;
}

/** Charges the next due invoice. true = paid, false = failed, null = none due. */
async function chargeNextInvoice(d: BillingDeps, now: Date): Promise<boolean | null> {
  return withRetry(() =>
    d.sql.begin(async (tx) => {
      const [inv] = await tx<InvoiceToCharge[]>`
        select id, tenant_id, total_cents, attempts, to_char(period_start, 'YYYY-MM-DD') as period_start
          from invoices
         where status in ('open', 'failed') and next_attempt_at <= ${now}
         order by next_attempt_at
         limit 1
           for update skip locked`;
      if (!inv) return null;
      return chargeInvoice(d, tx, inv, now);
    }),
  );
}

/**
 * One charge attempt for a locked invoice. Every attempt has its own Stripe Idempotency-Key
 * (invoice id + attempt number): a retry of the same attempt replays, a new attempt (later, or with
 * a new card) really tries again. Gateway outages count as failed attempts (retried later).
 */
async function chargeInvoice(d: BillingDeps, tx: Db, inv: InvoiceToCharge, now: Date): Promise<boolean> {
  const attempt = inv.attempts + 1;
  const [acct] = await tx<{ stripeCustomerId: string; paymentMethodId: string | null }[]>`
    select stripe_customer_id, payment_method_id from billing_accounts where tenant_id = ${inv.tenantId}`;

  let error: string | null = null;
  let paymentIntentId: string | null = null;
  let charged = inv.totalCents;
  if (inv.totalCents < MIN_CHARGE_CENTS) {
    charged = 0; // below Stripe's minimum charge: waived, like prorated amounts
  } else if (!acct?.paymentMethodId) {
    error = 'no saved card';
  } else {
    try {
      const result = await d.stripe.charge(
        {
          customerId: acct.stripeCustomerId,
          paymentMethodId: acct.paymentMethodId,
          amountCents: inv.totalCents,
          description: `Invoice for the period starting ${inv.periodStart}`,
          tenantId: inv.tenantId,
        },
        `invoice:${inv.id}:${attempt}`,
      );
      paymentIntentId = result.paymentIntentId;
      if (!result.ok) error = result.message;
    } catch (err) {
      error = `payment gateway error: ${(err as Error).message}`;
    }
  }

  await tx`
    insert into payments (tenant_id, purpose, period_start, idempotency_key, amount_cents,
                          stripe_payment_intent_id, status, failure_message, invoice_id)
    values (${inv.tenantId}, 'invoice', ${inv.periodStart}, ${`invoice:${inv.id}:${attempt}`}, ${charged},
            ${paymentIntentId}, ${error ? 'failed' : 'succeeded'}, ${error}, ${inv.id})
    on conflict (idempotency_key) do update
      set status = excluded.status, stripe_payment_intent_id = excluded.stripe_payment_intent_id,
          failure_message = excluded.failure_message`;

  if (error) {
    const delay = RETRY_DELAYS_SEC[Math.min(attempt, RETRY_DELAYS_SEC.length) - 1]!;
    await tx`
      update invoices set status = 'failed', attempts = ${attempt}, last_error = ${error},
                          next_attempt_at = ${new Date(now.getTime() + delay * 1000)}
       where id = ${inv.id}`;
    d.log.warn({ tenantId: inv.tenantId, invoiceId: inv.id, attempt, error }, 'invoice charge failed');
    return false;
  }
  await tx`
    update invoices set status = 'paid', attempts = ${attempt}, last_error = null, next_attempt_at = null, paid_at = ${now}
     where id = ${inv.id}`;
  // Paid up: a past-due account is active again (NOTIFY -> the call path unblocks within seconds).
  const reactivated = await tx`
    update tenants set status = 'active'
     where id = ${inv.tenantId} and status = 'past_due'
       and not exists (select 1 from invoices where tenant_id = ${inv.tenantId} and status in ('open', 'failed'))
    returning id`;
  if (reactivated.length) d.log.info({ tenantId: inv.tenantId }, 'account active again');
  return true;
}

/**
 * Charges every unpaid invoice of the account now, on the (new) saved card: billing-flows §5 "a
 * customer adds a new card: charge every overdue invoice immediately; on success set active".
 * Returns how many are still unpaid afterwards (0 = all paid).
 */
export async function payOverdue(d: BillingDeps, tenantId: string, now = new Date()): Promise<{ paid: number; unpaid: number; lastError: string | null }> {
  let paid = 0;
  let unpaid = 0;
  let lastError: string | null = null;
  const ids = await withRetry(
    () => d.sql<{ id: string }[]>`
      select id from invoices where tenant_id = ${tenantId} and status in ('open', 'failed') order by period_start`,
  );
  for (const { id } of ids) {
    const ok = await withRetry(() =>
      d.sql.begin(async (tx) => {
        const [inv] = await tx<InvoiceToCharge[]>`
          select id, tenant_id, total_cents, attempts, to_char(period_start, 'YYYY-MM-DD') as period_start
            from invoices where id = ${id} and status in ('open', 'failed')
             for update`;
        if (!inv) return true; // paid meanwhile
        const result = await chargeInvoice(d, tx, inv, now);
        if (!result) {
          const [row] = await tx<{ lastError: string | null }[]>`select last_error from invoices where id = ${id}`;
          lastError = row?.lastError ?? null;
        }
        return result;
      }),
    );
    if (ok) paid++;
    else unpaid++;
  }
  return { paid, unpaid, lastError };
}

// ---- 3. past due --------------------------------------------------------------------------------

async function markPastDue(d: BillingDeps, now: Date): Promise<number> {
  const rows = await withRetry(
    () => d.sql<{ id: string }[]>`
      update tenants t set status = 'past_due'
       where t.status = 'active'
         and exists (select 1 from invoices i
                      where i.tenant_id = t.id and i.status in ('open', 'failed') and i.due_at <= ${now})
      returning t.id`,
  );
  for (const r of rows) d.log.warn({ tenantId: r.id }, 'account past due: outgoing calls blocked');
  return rows.length;
}

// ---- 4. lapsed add-ons --------------------------------------------------------------------------

/**
 * Switches off add-ons whose cancelled period ended. Only accounts that ever had items of that kind
 * are touched, so flags set by hand (seeds, tests) on accounts without items stay as they are.
 */
async function expireLapsedAddons(d: BillingDeps, now: Date): Promise<number> {
  const tenants = await withRetry(
    () => d.sql<{ tenantId: string }[]>`
      select ts.tenant_id from tenant_settings ts
       where (ts.intl_calling
              and exists (select 1 from account_items i where i.tenant_id = ts.tenant_id and i.kind = 'intl_calling')
              and not exists (select 1 from account_items i where i.tenant_id = ts.tenant_id and i.kind = 'intl_calling'
                                and (i.removed_at is null or i.paid_through > ${now})))
          or (ts.record_calls
              and exists (select 1 from account_items i where i.tenant_id = ts.tenant_id and i.kind = 'recording')
              and not exists (select 1 from account_items i where i.tenant_id = ts.tenant_id and i.kind = 'recording'
                                and (i.removed_at is null or i.paid_through > ${now})))
       limit ${BATCH}`,
  );
  for (const t of tenants) await withRetry(() => syncSettings(d.sql, t.tenantId, now));
  return tenants.length;
}
