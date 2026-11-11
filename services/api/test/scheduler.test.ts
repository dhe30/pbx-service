import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { PLAN, PRICES } from '../src/billing/catalog.js';
import { RETRY_DELAYS_SEC, runBillingTick } from '../src/billing/scheduler.js';
import { FakeStripe, build, connectTestDb } from './helpers.js';

// Billing scheduler: weekly invoices, retries, past due, recovery (docs/billing-flows.md §4-§5).
// Accounts here live in UTC and signed up on 2026-10-05, so periods start at midnight UTC every
// 7 days: [10-05, 10-12), [10-12, 10-19), ... Ticks run with an injected "now".

const db = await connectTestDb();

describe.skipIf(!db)('billing scheduler (Postgres)', () => {
  const sql = db as Sql;
  const stripe = new FakeStripe();
  const log = pino({ level: 'silent' });
  const deps = { sql, stripe, log };
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  const at = (s: string) => new Date(s);
  const P1_END = at('2026-10-12T00:00:00Z');
  const P2_END = at('2026-10-19T00:00:00Z');

  beforeAll(async () => {
    app = await build({ sql, stripe });
  });
  afterAll(async () => {
    if (tenantIds.length) {
      await sql`delete from phone_numbers where tenant_id = any(${tenantIds}::uuid[])`;
      await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    }
    await sql.end({ timeout: 2 });
  });

  /** A paid-up account in its first period, with an extra extension, a number and a cancelled add-on. */
  async function makeAccount() {
    const [t] = await sql<{ id: string }[]>`
      insert into tenants (name, timezone, created_at) values ('Scheduler test', 'UTC', '2026-10-05T12:00:00Z') returning id`;
    const id = t!.id;
    tenantIds.push(id);
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role) values (${id}, ${`o-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    const customer = `cus_sched_${id}`;
    await sql`insert into tenant_settings (tenant_id, included_extensions, included_us_minutes, intl_calling, extra_extensions)
              values (${id}, 2, 100, true, 1)`;
    await sql`insert into billing_accounts (tenant_id, stripe_customer_id, payment_method_id, plan_paid_through)
              values (${id}, ${customer}, 'pm_card_visa', ${P1_END})`;
    const did = `+1201555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
    const [n] = await sql<{ id: string }[]>`
      insert into phone_numbers (did, tenant_id, status, kind, paid_until) values (${did}, ${id}, 'assigned', 'local', ${P1_END}) returning id`;
    await sql`insert into account_items ${sql([
      { tenant_id: id, kind: 'plan', price_cents: PLAN.priceCents, paid_through: P1_END, phone_number_id: null, removed_at: null },
      { tenant_id: id, kind: 'extension', price_cents: PRICES.extensionCents, paid_through: P1_END, phone_number_id: null, removed_at: null },
      { tenant_id: id, kind: 'number', price_cents: PRICES.localNumberCents, paid_through: P1_END, phone_number_id: n!.id, removed_at: null },
      // Cancelled during the first period: not renewed, switched off when the period ends.
      { tenant_id: id, kind: 'intl_calling', price_cents: PRICES.intlCallingCents, paid_through: P1_END, phone_number_id: null, removed_at: at('2026-10-08T00:00:00Z') },
    ])}`;
    const cookies = { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: id, role: 'owner', typ: 'access' }) };
    return { id, did, numberId: n!.id, customer, cookies };
  }

  async function addCdr(tenantId: string, startedAt: string, charge: number, extra: Partial<Record<string, unknown>> = {}) {
    await sql`insert into cdrs ${sql({
      id: randomUUID(), call_id: randomUUID(), tenant_id: tenantId, direction: 'outgoing', from_number: '101',
      to_number: '+442071234567', did: null, started_at: startedAt, answered_at: startedAt, ended_at: startedAt,
      billable_sec: 66, outcome: 'answered', charge, cost: 0, pbx_node: 'test', ...extra,
    })}`;
  }

  it('invoices the new period: renewals, per-call usage, included minutes; charges it; lapses cancelled add-ons', async () => {
    const t = await makeAccount();
    await addCdr(t.id, '2026-10-06T10:00:00Z', 0.0251);
    await addCdr(t.id, '2026-10-11T23:59:00Z', 0.0302, { direction: 'incoming', from_number: '+12125550199', did: t.did, to_number: t.did });
    await addCdr(t.id, '2026-10-07T10:00:00Z', 0); // free: not on the invoice
    await addCdr(t.id, '2026-10-12T00:10:00Z', 0.5); // next period's usage
    await sql`insert into usage_periods (tenant_id, period_start, included_sec_used) values (${t.id}, '2026-10-05', 600)`;

    // Before the period ends: nothing to do.
    expect((await runBillingTick(deps, at('2026-10-11T23:00:00Z'))).invoiced).toBe(0);

    const charges = stripe.charges.length;
    const tick = await runBillingTick(deps, at('2026-10-12T00:30:00Z'));
    expect(tick.invoiced).toBeGreaterThanOrEqual(1);

    const [inv] = await sql`select * from invoices where tenant_id = ${t.id}`;
    const recurring = PLAN.priceCents + PRICES.extensionCents + PRICES.localNumberCents;
    expect(inv).toMatchObject({
      periodStartAt: P1_END, periodEndAt: P2_END, usageFrom: at('2026-10-05T00:00:00Z'), usageTo: P1_END,
      recurringCents: recurring, usageCents: 6, totalCents: recurring + 6, includedSecUsed: '600', status: 'paid', attempts: 1,
    });
    const charge = stripe.charges.slice(charges).find((c) => c.key === `invoice:${inv!.id}:1`)!;
    expect(charge).toMatchObject({ customerId: t.customer, amountCents: recurring + 6 });

    // Renewed through the new period; the cancelled add-on was not, and is switched off.
    const items = await sql<{ kind: string; paidThrough: Date }[]>`select kind, paid_through from account_items where tenant_id = ${t.id} order by kind`;
    expect(items).toEqual([
      { kind: 'extension', paidThrough: P2_END },
      { kind: 'intl_calling', paidThrough: P1_END },
      { kind: 'number', paidThrough: P2_END },
      { kind: 'plan', paidThrough: P2_END },
    ]);
    expect((await sql`select paid_until from phone_numbers where id = ${t.numberId}`)[0]!.paidUntil).toEqual(P2_END);
    expect((await sql`select plan_paid_through from billing_accounts where tenant_id = ${t.id}`)[0]!.planPaidThrough).toEqual(P2_END);
    expect((await sql`select intl_calling from tenant_settings where tenant_id = ${t.id}`)[0]!.intlCalling).toBe(false);

    // Through the API.
    const list = await app.inject({ method: 'GET', url: '/invoices', cookies: t.cookies });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      expect.objectContaining({ id: inv!.id, totalCents: recurring + 6, status: 'paid', pastDue: false, includedMinutesUsed: 10 }),
    ]);
    const detail = (await app.inject({ method: 'GET', url: `/invoices/${inv!.id}`, cookies: t.cookies })).json();
    expect(detail.lines.map((l: { kind: string; itemKind: string | null; amount: number }) => [l.kind, l.itemKind, l.amount])).toEqual([
      ['recurring', 'plan', PLAN.priceCents / 100],
      ['recurring', 'extension', PRICES.extensionCents / 100],
      ['recurring', 'number', PRICES.localNumberCents / 100],
      ['usage', null, 0.0251],
      ['usage', null, 0.0302],
    ]);
    expect(detail.lines[2].description).toContain(t.did);
    expect(detail.lines[4].description).toMatch(/^Incoming toll-free call from \+12125550199/);

    // Idempotent: another tick (or another app node) does nothing more.
    const again = await runBillingTick(deps, at('2026-10-12T00:45:00Z'));
    expect(await sql`select 1 from invoices where tenant_id = ${t.id}`).toHaveLength(1);
    expect(again.charged).toBe(0);
    // Staff and other accounts can't read it.
    const other = await makeAccount();
    expect((await app.inject({ method: 'GET', url: `/invoices/${inv!.id}`, cookies: other.cookies })).statusCode).toBe(404);
  });

  it('declines are retried with backoff, the account goes past due after 24 h, and a new card pays and unblocks it', async () => {
    const t = await makeAccount();
    stripe.declineWith = 'Your card was declined.';
    try {
      await runBillingTick(deps, at('2026-10-12T00:30:00Z'));
      const [inv] = await sql`select id, status, attempts, next_attempt_at, last_error from invoices where tenant_id = ${t.id}`;
      expect(inv).toMatchObject({ status: 'failed', attempts: 1, lastError: 'Your card was declined.' });
      expect(inv!.nextAttemptAt).toEqual(new Date(at('2026-10-12T00:30:00Z').getTime() + RETRY_DELAYS_SEC[0]! * 1000));

      // Not retried before its time.
      await runBillingTick(deps, at('2026-10-12T00:31:00Z'));
      expect((await sql`select attempts from invoices where id = ${inv!.id}`)[0]!.attempts).toBe(1);

      // Retried later; still declined. More than 24 h after the period ended: past due.
      await runBillingTick(deps, at('2026-10-13T00:10:00Z'));
      expect((await sql`select attempts, status from invoices where id = ${inv!.id}`)[0]).toEqual({ attempts: 2, status: 'failed' });
      expect((await sql`select status from tenants where id = ${t.id}`)[0]!.status).toBe('past_due');
      const listed = (await app.inject({ method: 'GET', url: '/invoices', cookies: t.cookies })).json();
      expect(listed[0]).toMatchObject({ status: 'failed', pastDue: true, attempts: 2 });

      // Adding a card that is also declined: saved, but 402 and still past due.
      const setup1 = (await app.inject({ method: 'POST', url: '/billing/setup-intent', cookies: t.cookies })).json();
      stripe.completeSetup(setup1.setupIntentId);
      const declined = await app.inject({ method: 'POST', url: '/billing/card', cookies: t.cookies, payload: { setupIntentId: setup1.setupIntentId } });
      expect(declined.statusCode).toBe(402);
      expect(declined.json().error).toBe('payment_failed');
      expect((await sql`select status from tenants where id = ${t.id}`)[0]!.status).toBe('past_due');
    } finally {
      stripe.declineWith = null;
    }

    // A good card: the overdue invoice is charged at once and the account is active again.
    const setup2 = (await app.inject({ method: 'POST', url: '/billing/setup-intent', cookies: t.cookies })).json();
    stripe.completeSetup(setup2.setupIntentId, { brand: 'visa', last4: '1111' });
    const saved = await app.inject({ method: 'POST', url: '/billing/card', cookies: t.cookies, payload: { setupIntentId: setup2.setupIntentId } });
    expect(saved.statusCode).toBe(200);
    const [inv] = await sql`select status, attempts from invoices where tenant_id = ${t.id}`;
    expect(inv).toEqual({ status: 'paid', attempts: 4 });
    expect((await sql`select status from tenants where id = ${t.id}`)[0]!.status).toBe('active');
    const payments = await sql`select status from payments where tenant_id = ${t.id} and purpose = 'invoice' order by created_at`;
    expect(payments.map((p) => p.status)).toEqual(['failed', 'failed', 'failed', 'succeeded']);
  });

  it('catches up period by period after downtime, and skips accounts that never paid the plan', async () => {
    const t = await makeAccount();
    const [unpaid] = await sql<{ id: string }[]>`
      insert into tenants (name, timezone, created_at) values ('Never paid', 'UTC', '2026-10-05T12:00:00Z') returning id`;
    tenantIds.push(unpaid!.id);
    await runBillingTick(deps, at('2026-10-26T01:00:00Z'));
    const invoices = await sql<{ periodStart: string }[]>`
      select to_char(period_start, 'YYYY-MM-DD') as period_start from invoices where tenant_id = ${t.id} order by period_start`;
    expect(invoices.map((i) => i.periodStart)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26']);
    expect(await sql`select 1 from invoices where tenant_id = ${unpaid!.id}`).toHaveLength(0);
    expect((await sql`select paid_through from account_items where tenant_id = ${t.id} and kind = 'plan'`)[0]!.paidThrough).toEqual(
      at('2026-11-02T00:00:00Z'),
    );
  });
});

describe.skipIf(!db)('voicemail audio cleanup (Postgres)', () => {
  it('deletes media of voicemails deleted by phone (*98), after a grace period, and their objects', async () => {
    const sql = (await connectTestDb())!;
    const { MemoryStore } = await import('./helpers.js');
    const { cleanupOrphanVoicemailMedia, ORPHAN_GRACE_SEC } = await import('../src/maintenance.js');
    const store = new MemoryStore();
    const log = pino({ level: 'silent' });
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('Cleanup test') returning id`;
    try {
      const [mb] = await sql<{ id: string }[]>`insert into mailboxes (tenant_id, name) values (${t!.id}, 'MB') returning id`;
      const media = async (key: string, kind: string, age: number) => {
        await store.put(key, Buffer.from('RIFF'), 'audio/wav');
        const [m] = await sql<{ id: string }[]>`
          insert into media (tenant_id, kind, object_key, format, duration_ms, created_at)
          values (${t!.id}, ${kind}, ${key}, 'wav', 1000, now() - make_interval(secs => ${age})) returning id`;
        return m!.id;
      };
      const old = ORPHAN_GRACE_SEC + 60;
      const orphan = await media(`t/${randomUUID()}.wav`, 'voicemail', old); // its message was deleted by *98
      const kept = await media(`t/${randomUUID()}.wav`, 'voicemail', old);
      await sql`insert into voicemails (tenant_id, mailbox_id, media_id) values (${t!.id}, ${mb!.id}, ${kept})`;
      const fresh = await media(`t/${randomUUID()}.wav`, 'voicemail', 10);
      const greeting = await media(`t/${randomUUID()}.wav`, 'greeting', old);

      expect(await cleanupOrphanVoicemailMedia({ sql, store, log })).toBeGreaterThanOrEqual(1);
      const left = (await sql<{ id: string }[]>`select id from media where tenant_id = ${t!.id}`).map((r) => r.id);
      expect(left.sort()).toEqual([kept, fresh, greeting].sort());
      expect(left).not.toContain(orphan);
      expect(store.objects.size).toBe(3);
    } finally {
      await sql`delete from tenants where id = ${t!.id}`;
      await sql.end({ timeout: 2 });
    }
  });
});
