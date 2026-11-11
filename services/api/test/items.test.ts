import { randomUUID } from 'node:crypto';
import { billingPeriod, type Sql } from '@pbx/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { PRICES, proratedCents } from '../src/billing/catalog.js';
import { FakeStripe, build, connectTestDb, payPlan } from './helpers.js';

// Buying and cancelling additional extensions and add-ons (/billing/items, docs/billing-flows.md §3).

describe('item routes without a DB', () => {
  it('are owner-only and need an Idempotency-Key to buy', async () => {
    const app = await build();
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    const owner = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'owner', typ: 'access' });
    for (const [method, url] of [
      ['GET', '/billing/items'],
      ['POST', '/billing/items'],
      ['DELETE', `/billing/items/${randomUUID()}`],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
      expect((await app.inject({ method, url, payload: {}, cookies: { [ACCESS_COOKIE]: staff } })).statusCode, url).toBe(403);
    }
    const noKey = await app.inject({ method: 'POST', url: '/billing/items', payload: { kind: 'recording' }, cookies: { [ACCESS_COOKIE]: owner } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().message).toMatch(/Idempotency-Key/);
    const badKind = await app.inject({
      method: 'POST', url: '/billing/items', payload: { kind: 'plan' }, cookies: { [ACCESS_COOKIE]: owner }, headers: { 'idempotency-key': 'k1' },
    });
    expect(badKind.statusCode).toBe(400);
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('additional extensions and add-ons (Postgres)', () => {
  const sql = db as Sql;
  const stripe = new FakeStripe();
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    app = await build({ sql, stripe });
  });
  afterAll(async () => {
    if (tenantIds.length) await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  async function makeTenant(o: { includedExtensions?: number } = {}) {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name, timezone) values ('Items test', 'America/Chicago') returning id`;
    const id = t!.id;
    tenantIds.push(id);
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role) values (${id}, ${`o-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    await payPlan(sql, id, o.includedExtensions ?? 2);
    await sql`update billing_accounts set payment_method_id = 'pm_card_visa' where tenant_id = ${id}`;
    const cookies = { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: id, role: 'owner', typ: 'access' }) };
    const call = (method: InjectOptions['method'], url: string, payload?: object, headers?: Record<string, string>) =>
      app.inject({ method, url, payload, cookies, headers });
    const buy = (kind: string, key = randomUUID()) => call('POST', '/billing/items', { kind }, { 'idempotency-key': key });
    const settings = async () => (await call('GET', '/settings')).json();
    return { id, call, buy, settings };
  }

  async function dueNow(tenantId: string, priceCents: number) {
    const [t] = await sql<{ createdAt: Date }[]>`select created_at from tenants where id = ${tenantId}`;
    const now = new Date();
    return proratedCents(priceCents, billingPeriod('America/Chicago', t!.createdAt, now), now);
  }

  it('buys international calling: prorated charge, flag on for the call path, replay-safe', async () => {
    const t = await makeTenant();
    expect((await t.settings()).intlCalling).toBe(false);
    const key = randomUUID();
    const charges = stripe.charges.length;
    const res = await t.buy('intl_calling', key);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ item: { kind: 'intl_calling', priceCents: PRICES.intlCallingCents, renews: true, removedAt: null }, replayed: false });
    expect(Math.abs(body.chargedCents - (await dueNow(t.id, PRICES.intlCallingCents)))).toBeLessThanOrEqual(1);
    expect(stripe.charges.length).toBe(charges + 1);
    expect((await t.settings()).intlCalling).toBe(true);

    // Same key: replayed, no second charge.
    const again = await t.buy('intl_calling', key);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ item: { id: body.item.id }, chargedCents: body.chargedCents, replayed: true });
    expect(stripe.charges.length).toBe(charges + 1);
    // Same key, different item: refused.
    expect((await t.buy('recording', key)).json().error).toBe('idempotency_key_reused');
    // New key while it renews: already active, nothing charged.
    const dup = await t.buy('intl_calling');
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('already_active');
    expect(stripe.charges.length).toBe(charges + 1);

    const items = (await t.call('GET', '/billing/items')).json();
    expect(items.map((i: { kind: string }) => i.kind)).toEqual(['intl_calling']);
  });

  it('cancelling an add-on keeps it until the period ends; buying it again then resumes it for free', async () => {
    const t = await makeTenant();
    const item = (await t.buy('recording')).json().item;
    expect((await t.settings()).recordCalls).toBe(true);

    const cancelled = await t.call('DELETE', `/billing/items/${item.id}`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ id: item.id, renews: false, paidThrough: item.paidThrough });
    expect((await t.settings()).recordCalls).toBe(true); // still paid for
    expect((await t.call('DELETE', `/billing/items/${item.id}`)).statusCode).toBe(200); // twice is fine

    const charges = stripe.charges.length;
    const resumed = await t.buy('recording');
    expect(resumed.statusCode).toBe(201);
    expect(resumed.json()).toMatchObject({ item: { id: item.id, renews: true }, chargedCents: 0 });
    expect(stripe.charges.length).toBe(charges);

    // After the paid period a cancelled add-on is gone from the list (the scheduler turns the flag off).
    await t.call('DELETE', `/billing/items/${item.id}`);
    await sql`update account_items set paid_through = now() - interval '1 minute' where id = ${item.id}`;
    expect((await t.call('GET', '/billing/items')).json()).toEqual([]);
    expect((await t.call('DELETE', `/billing/items/${item.id}`)).statusCode).toBe(404);
  });

  it('an additional extension raises the limit; it can only be cancelled when the extensions fit without it', async () => {
    const t = await makeTenant({ includedExtensions: 1 });
    expect((await t.call('POST', '/extensions', { number: '101', name: 'One' })).statusCode).toBe(201);
    expect((await t.call('POST', '/extensions', { number: '102', name: 'Two' })).json().error).toBe('extension_limit');

    const slot = (await t.buy('extension')).json().item;
    expect(slot).toMatchObject({ kind: 'extension', priceCents: PRICES.extensionCents });
    expect((await t.call('GET', '/billing')).json().extensions).toEqual({ used: 1, allowed: 2 });
    const two = await t.call('POST', '/extensions', { number: '102', name: 'Two' });
    expect(two.statusCode).toBe(201);

    const refused = await t.call('DELETE', `/billing/items/${slot.id}`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('extension_limit');
    expect((await t.call('DELETE', `/extensions/${two.json().id}`)).statusCode).toBe(204);
    expect((await t.call('DELETE', `/billing/items/${slot.id}`)).statusCode).toBe(200);
    expect((await t.call('GET', '/billing')).json().extensions).toEqual({ used: 1, allowed: 1 });

    // Several slots can be bought (no "already active" for extensions).
    expect((await t.buy('extension')).statusCode).toBe(201);
    expect((await t.buy('extension')).statusCode).toBe(201);
    expect((await t.settings()).extraExtensions).toBe(2);
  });

  it('a declined card buys nothing and the decline is replayed; past due accounts cannot buy', async () => {
    const t = await makeTenant();
    const key = randomUUID();
    stripe.declineWith = 'Your card was declined.';
    try {
      const res = await t.buy('intl_calling', key);
      expect(res.statusCode).toBe(402);
      expect(res.json().error).toBe('payment_failed');
    } finally {
      stripe.declineWith = null;
    }
    expect((await t.settings()).intlCalling).toBe(false);
    expect((await t.buy('intl_calling', key)).json().error).toBe('payment_failed');
    expect((await t.call('GET', '/billing/items')).json()).toEqual([]);

    await sql`update tenants set status = 'past_due' where id = ${t.id}`;
    const pastDue = await t.buy('intl_calling');
    expect(pastDue.statusCode).toBe(402);
    expect(pastDue.json().error).toBe('payment_required');
  });

  it('the plan and numbers are items too, but are not cancelled here', async () => {
    const t = await makeTenant();
    const [plan] = await sql<{ id: string }[]>`
      insert into account_items (tenant_id, kind, price_cents, paid_through) values (${t.id}, 'plan', 1900, now() + interval '3 days') returning id`;
    const res = await t.call('DELETE', `/billing/items/${plan!.id}`);
    expect(res.statusCode).toBe(400);
    expect((await t.call('GET', '/billing/items')).json()).toMatchObject([{ kind: 'plan', renews: true }]);
    // Another account's item: 404.
    const other = await makeTenant();
    expect((await other.call('DELETE', `/billing/items/${plan!.id}`)).statusCode).toBe(404);
  });
});
