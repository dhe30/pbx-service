import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { CEILINGS_CENTS, PLAN, PREPAID, topUpCents } from '../src/billing/catalog.js';
import { rechargeNext, TOPUP_RETRY_DELAYS_SEC } from '../src/billing/credit.js';
import { runBillingTick } from '../src/billing/scheduler.js';
import { FakeStripe, build, connectTestDb } from './helpers.js';

// Prepaid usage: credit balance, deduction as calls end (trigger
// on cdrs), automatic top-ups below the threshold, and the invoice split at prepaid_since.

const db = await connectTestDb();

describe('prepaid prices (no DB)', () => {
  it('publishes the top-up within the ceiling, at least once, rounded up per 10 extensions', () => {
    expect(PREPAID.topUpCentsPer10Extensions).toBeLessThanOrEqual(CEILINGS_CENTS.topUpPer10Extensions);
    expect(topUpCents(0)).toBe(PREPAID.topUpCentsPer10Extensions);
    expect(topUpCents(1)).toBe(PREPAID.topUpCentsPer10Extensions);
    expect(topUpCents(10)).toBe(PREPAID.topUpCentsPer10Extensions);
    expect(topUpCents(11)).toBe(2 * PREPAID.topUpCentsPer10Extensions);
    expect(topUpCents(98)).toBe(10 * PREPAID.topUpCentsPer10Extensions);
  });
});

describe.skipIf(!db)('prepaid usage (Postgres)', () => {
  const sql = db as Sql;
  const stripe = new FakeStripe();
  const log = pino({ level: 'silent' });
  const deps = { sql, stripe, log };
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await build({ sql, stripe });
  });
  afterAll(async () => {
    if (tenantIds.length) await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  /** A paid-up account with a card, `extensions` extensions, prepaid since `prepaidSince`. */
  async function makeAccount(o: { extensions?: number; prepaidSince?: string; createdAt?: string; card?: boolean } = {}) {
    const [t] = await sql<{ id: string }[]>`
      insert into tenants (name, timezone, created_at, prepaid_since)
      values ('Prepaid test', 'UTC', ${o.createdAt ?? '2026-10-05T12:00:00Z'}, ${o.prepaidSince ?? '2026-10-05T12:00:00Z'})
      returning id`;
    const id = t!.id;
    tenantIds.push(id);
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role) values (${id}, ${`p-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    await sql`insert into tenant_settings (tenant_id, included_extensions, included_us_minutes) values (${id}, 100, 100)`;
    await sql`insert into billing_accounts (tenant_id, stripe_customer_id, payment_method_id, plan_paid_through)
              values (${id}, ${`cus_prepaid_${id}`}, ${o.card === false ? null : 'pm_card_visa'}, '2026-10-12T00:00:00Z')`;
    for (let i = 0; i < (o.extensions ?? 0); i++) {
      await sql`insert into extensions (tenant_id, number, name, sip_username)
                values (${id}, ${String(100 + i)}, ${`Ext ${i}`}, ${`x${randomUUID().replaceAll('-', '').slice(0, 16)}`})`;
    }
    const cookies = { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: id, role: 'owner', typ: 'access' }) };
    return { id, cookies };
  }

  async function addCdr(tenantId: string, startedAt: string, charge: number, id = randomUUID()) {
    await sql`insert into cdrs ${sql({
      id, call_id: randomUUID(), tenant_id: tenantId, direction: 'outgoing', from_number: '101',
      to_number: '+12025550100', did: null, started_at: startedAt, answered_at: startedAt, ended_at: startedAt,
      billable_sec: 60, outcome: 'answered', charge, cost: 0, pbx_node: 'test',
    })} on conflict (id) do nothing`;
    return id;
  }

  const credit = async (tenantId: string) =>
    Number((await sql<{ credit: string }[]>`select credit from credit_balances where tenant_id = ${tenantId}`)[0]?.credit ?? 0);

  it('deducts charged legs started on or after prepaid_since, once, and nothing else', async () => {
    const t = await makeAccount({ prepaidSince: '2026-10-07T00:00:00Z' });
    await addCdr(t.id, '2026-10-06T10:00:00Z', 0.5); // postpaid: before the switch
    await addCdr(t.id, '2026-10-07T10:00:00Z', 0); // free leg
    const id = await addCdr(t.id, '2026-10-07T11:00:00Z', 0.123456);
    await addCdr(t.id, '2026-10-07T11:00:00Z', 0.123456, id); // replayed spool file: on conflict do nothing
    await addCdr(t.id, '2026-10-07T12:00:00Z', 0.2);
    expect(await credit(t.id)).toBeCloseTo(-0.323456, 6);
  });

  it('charges one top-up below the threshold, sized by extensions, and none at or above it', async () => {
    const t = await makeAccount({ extensions: 12 });
    const now = new Date('2026-10-08T00:00:00Z');
    expect(await rechargeNext(deps, now, t.id)).toBe('charged');
    expect(await credit(t.id)).toBeCloseTo(10, 6); // 12 extensions = 2 x $5
    const charge = stripe.charges.at(-1)!;
    expect(charge.amountCents).toBe(1000);
    expect(charge.key).toBe(`topup:${t.id}:1:1`);
    expect(await rechargeNext(deps, now, t.id)).toBeNull(); // at the threshold: nothing due

    await addCdr(t.id, '2026-10-08T01:00:00Z', 0.01); // $9.99 < $10: due again
    expect(await rechargeNext(deps, now, t.id)).toBe('charged');
    expect(await credit(t.id)).toBeCloseTo(19.99, 6);
    expect(stripe.charges.at(-1)!.key).toBe(`topup:${t.id}:2:1`);

    const [p] = await sql<{ n: number; cents: number }[]>`
      select count(*)::int as n, sum(amount_cents)::int as cents from payments
       where tenant_id = ${t.id} and purpose = 'topup' and status = 'succeeded'`;
    expect(p).toEqual({ n: 2, cents: 2000 });
  });

  it('never refuses: the balance may go negative, and the next top-ups bring it back up', async () => {
    const t = await makeAccount({ extensions: 3 });
    await addCdr(t.id, '2026-10-08T01:00:00Z', 7.5); // -$7.50 before any top-up
    const now = new Date('2026-10-08T02:00:00Z');
    expect(await rechargeNext(deps, now, t.id)).toBe('charged'); // -2.50
    expect(await rechargeNext(deps, now, t.id)).toBe('charged'); // 2.50
    expect(await rechargeNext(deps, now, t.id)).toBe('charged'); // 7.50
    expect(await rechargeNext(deps, now, t.id)).toBeNull();
    expect(await credit(t.id)).toBeCloseTo(7.5, 6);
  });

  it('retries a declined top-up with backoff and a new attempt key; skips accounts without a card', async () => {
    const t = await makeAccount();
    const noCard = await makeAccount({ card: false });
    const now = new Date('2026-10-09T00:00:00Z');
    stripe.declineWith = 'Your card was declined.';
    try {
      expect(await rechargeNext(deps, now, t.id)).toBe('failed');
    } finally {
      stripe.declineWith = null;
    }
    expect(await credit(t.id)).toBe(0);
    expect(await rechargeNext(deps, new Date(now.getTime() + 1000), t.id)).toBeNull(); // backing off
    const later = new Date(now.getTime() + TOPUP_RETRY_DELAYS_SEC[0]! * 1000);
    expect(await rechargeNext(deps, later, t.id)).toBe('charged');
    expect(stripe.charges.at(-1)!.key).toBe(`topup:${t.id}:1:2`);
    expect(await credit(t.id)).toBeCloseTo(5, 6);
    expect(await rechargeNext(deps, later, noCard.id)).toBeNull();
  });

  it('the billing tick tops up every account that is due', async () => {
    const a = await makeAccount();
    const b = await makeAccount({ extensions: 25 });
    const r = await runBillingTick(deps, new Date('2026-10-09T06:00:00Z'));
    expect(r.toppedUp).toBeGreaterThanOrEqual(2);
    expect(await credit(a.id)).toBeCloseTo(5, 6);
    expect(await credit(b.id)).toBeCloseTo(15, 6);
  });

  it('invoices postpaid usage before the switch only, and shows credit charged and usage deducted', async () => {
    // Period [10-05, 10-12); switched to prepaid on 10-08.
    const t = await makeAccount({ prepaidSince: '2026-10-08T00:00:00Z' });
    await sql`insert into account_items (tenant_id, kind, price_cents, paid_through)
              values (${t.id}, 'plan', ${PLAN.priceCents}, '2026-10-12T00:00:00Z')`;
    await addCdr(t.id, '2026-10-06T10:00:00Z', 0.25); // postpaid
    await addCdr(t.id, '2026-10-09T10:00:00Z', 0.4); // prepaid
    await addCdr(t.id, '2026-10-10T10:00:00Z', 0.35); // prepaid
    expect(await rechargeNext(deps, new Date('2026-10-10T11:00:00Z'), t.id)).toBe('charged');

    await runBillingTick(deps, new Date('2026-10-12T00:30:00Z'));
    const [inv] = await sql<{ id: string; usageCents: number; recurringCents: number; totalCents: number; creditChargedCents: number; usageDeductedCents: number }[]>`
      select id, usage_cents, recurring_cents, total_cents, credit_charged_cents, usage_deducted_cents
        from invoices where tenant_id = ${t.id}`;
    expect(inv).toMatchObject({
      usageCents: 25,
      recurringCents: PLAN.priceCents,
      totalCents: PLAN.priceCents + 25,
      creditChargedCents: 500,
      usageDeductedCents: 75,
    });
    const usageLines = await sql`select 1 from invoice_lines where invoice_id = ${inv!.id} and kind = 'usage'`;
    expect(usageLines).toHaveLength(1);

    const res = await app.inject({ method: 'GET', url: `/invoices/${inv!.id}`, cookies: t.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ creditChargedCents: 500, usageDeductedCents: 75, totalCents: PLAN.priceCents + 25 });
  });

  it('publishes the model in the prices and reports the balance in GET /billing', async () => {
    const prices = await app.inject({ method: 'GET', url: '/billing/prices' });
    expect(prices.json()).toMatchObject({
      billingModel: 'prepaid',
      prepaid: { topUpCentsPer10Extensions: PREPAID.topUpCentsPer10Extensions, threshold: 'one_top_up' },
    });

    const t = await makeAccount({ extensions: 11 });
    await addCdr(t.id, '2026-10-08T01:00:00Z', 1.234);
    const res = await app.inject({ method: 'GET', url: '/billing', cookies: t.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().credit).toEqual({ balanceCents: -123, topUpCents: 1000, thresholdCents: 1000, lastTopUpAt: null });
  });
});
