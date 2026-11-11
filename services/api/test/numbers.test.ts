import { randomUUID } from 'node:crypto';
import { billingPeriod, type Sql } from '@pbx/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { PRICES, proratedCents } from '../src/billing/catalog.js';
import { FakeDidProvider } from '../src/numbers/fake-provider.js';
import { DidProviderError, type AvailableNumber, type OrderResult } from '../src/numbers/provider.js';
import { FakeStripe, build, connectTestDb, payPlan } from './helpers.js';

// Step 8: number search, purchase (idempotent, resumable), list, release.

describe('number routes without a DB', () => {
  it('require login; search, buy and release are owner-only', async () => {
    const app = await build();
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    const id = randomUUID();
    const ownerOnly = [
      ['GET', '/numbers/countries'],
      ['GET', '/numbers/regions'],
      ['GET', '/numbers/cities'],
      ['GET', '/numbers/available'],
      ['POST', '/numbers/purchase'],
      ['PUT', `/numbers/${id}/route`],
      ['DELETE', `/numbers/${id}`],
    ] as const;
    for (const [method, url] of [...ownerOnly, ['GET', '/numbers'], ['GET', `/numbers/${id}`]] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode, `${method} ${url} anonymous`).toBe(401);
    }
    for (const [method, url] of ownerOnly) {
      const res = await app.inject({ method, url, payload: {}, cookies: { [ACCESS_COOKIE]: staff } });
      expect(res.statusCode, `${method} ${url} as staff`).toBe(403);
    }
  });

  it('serves the lookups from the provider', async () => {
    const app = await build();
    const owner = { [ACCESS_COOKIE]: app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'owner', typ: 'access' }) };
    const countries = await app.inject({ method: 'GET', url: '/numbers/countries', cookies: owner });
    expect(countries.json()).toEqual([{ iso: 'US', name: 'United States', prefix: '1' }]);
    const regions = (await app.inject({ method: 'GET', url: '/numbers/regions?country=us', cookies: owner })).json();
    expect(regions).toContainEqual({ id: 'r-nj', name: 'New Jersey' });
    const cities = (await app.inject({ method: 'GET', url: '/numbers/cities?regionId=r-ny', cookies: owner })).json();
    expect(cities.map((c: { name: string }) => c.name)).toEqual(['Long Island', 'New York']);
    expect((await app.inject({ method: 'GET', url: '/numbers/regions?country=USA', cookies: owner })).statusCode).toBe(400);
  });

  it('needs an Idempotency-Key to buy', async () => {
    const app = await build();
    const owner = { [ACCESS_COOKIE]: app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'owner', typ: 'access' }) };
    const res = await app.inject({ method: 'POST', url: '/numbers/purchase', cookies: owner, payload: { availableNumberId: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/Idempotency-Key/);
    const bad = await app.inject({
      method: 'POST', url: '/numbers/purchase', cookies: owner, payload: { availableNumberId: 'x' }, headers: { 'idempotency-key': 'has spaces' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('maps provider outages to 502', async () => {
    const provider = new FakeDidProvider();
    provider.down = true;
    const app = await build({ didProvider: provider });
    const owner = { [ACCESS_COOKIE]: app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'owner', typ: 'access' }) };
    const res = await app.inject({ method: 'GET', url: '/numbers/countries', cookies: owner });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('did_provider_error');
  });
});

/** Fails like a timeout AFTER the provider accepted the order (the response was lost). */
class LostResponseProvider extends FakeDidProvider {
  loseNext = false;
  override async order(offer: AvailableNumber): Promise<OrderResult> {
    const r = await super.order(offer);
    if (this.loseNext) {
      this.loseNext = false;
      throw new DidProviderError('timeout');
    }
    return r;
  }
}

const db = await connectTestDb();

describe.skipIf(!db)('numbers (Postgres)', () => {
  const sql = db as Sql;
  const provider = new LostResponseProvider();
  const stripe = new FakeStripe();
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  interface Tenant {
    id: string;
    cookies: Record<string, string>;
    staff: Record<string, string>;
  }

  async function makeTenant(o: { card?: boolean } = {}): Promise<Tenant> {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name, timezone) values ('Numbers test', 'America/New_York') returning id`;
    const id = t!.id;
    tenantIds.push(id);
    const user = async (role: 'owner' | 'staff') => {
      const [u] = await sql<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, role)
        values (${id}, ${`${role}-${randomUUID()}@example.test`}, '!', ${role}) returning id`;
      return { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: id, role, typ: 'access' }) };
    };
    const cookies = await user('owner');
    const staff = await user('staff');
    if (o.card !== false) {
      await payPlan(sql, id);
      await sql`update billing_accounts set payment_method_id = 'pm_card_visa' where tenant_id = ${id}`;
    }
    return { id, cookies, staff };
  }

  const call = (cookies: Record<string, string>, method: InjectOptions['method'], url: string, payload?: object, headers?: Record<string, string>) =>
    app.inject({ method, url, payload, cookies, headers });
  const buy = (t: Tenant, availableNumberId: string, key = randomUUID()) =>
    call(t.cookies, 'POST', '/numbers/purchase', { availableNumberId }, { 'idempotency-key': key });

  /** A fresh offer id in the given area code. */
  async function offer(t: Tenant, query = 'areaCode=201'): Promise<{ id: string; number: string; dueNowCents: number }> {
    const res = await call(t.cookies, 'GET', `/numbers/available?${query}&limit=1`);
    expect(res.statusCode).toBe(200);
    return res.json()[0];
  }

  const ordersOf = (number: string) => provider.calls.filter(([op, n]) => op === 'order' && n === number).length;

  beforeAll(async () => {
    app = await build({ sql, stripe, didProvider: provider });
  });

  beforeEach(() => {
    provider.down = false;
    provider.pendingPolls = 0;
    stripe.down = false;
    stripe.declineWith = null;
  });

  afterAll(async () => {
    await sql`delete from phone_numbers where tenant_id = any(${tenantIds}::uuid[])`;
    await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('searches with our price and the prorated amount due now', async () => {
    const t = await makeTenant();
    const res = await call(t.cookies, 'GET', '/numbers/available?areaCode=201&limit=3');
    expect(res.statusCode).toBe(200);
    const offers = res.json();
    expect(offers).toHaveLength(3);
    const now = new Date();
    const period = billingPeriod('America/New_York', (await sql`select created_at from tenants where id = ${t.id}`)[0]!.createdAt, now);
    expect(offers[0]).toEqual({
      id: expect.stringMatching(/^fake-1201/), number: expect.stringMatching(/^\+1201555/), kind: 'local', country: 'US',
      region: 'New Jersey', city: 'Newark', areaCode: '201', priceCents: PRICES.localNumberCents,
      dueNowCents: expect.any(Number),
    });
    expect(Math.abs(offers[0].dueNowCents - proratedCents(PRICES.localNumberCents, period, now))).toBeLessThanOrEqual(1);
    expect(offers[0]).not.toHaveProperty('skuId');
    const tf = (await call(t.cookies, 'GET', '/numbers/available?kind=toll_free&limit=2')).json();
    expect(tf.every((o: { kind: string; priceCents: number }) => o.kind === 'toll_free' && o.priceCents === PRICES.tollFreeNumberCents)).toBe(true);
    const li = (await call(t.cookies, 'GET', '/numbers/available?cityId=c-li&limit=50')).json() as { areaCode: string; city: string }[];
    expect(li.length).toBeGreaterThan(0);
    expect(li.every((x) => ['516', '631'].includes(x.areaCode) && x.city === 'Long Island')).toBe(true);
  });

  it('buys a number: ordered, routed to our trunk, charged prorated, listed', async () => {
    const t = await makeTenant();
    const o = await offer(t);
    const key = randomUUID();
    const res = await buy(t, o.id, key);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      number: { did: o.number, status: 'assigned', kind: 'local', destination: null },
      chargedCents: o.dueNowCents,
      replayed: false,
    });
    const did = provider.owned.get(o.number)!;
    expect(did.trunk).toBe(true);
    const charge = stripe.charges.find((c) => c.key === `number:${t.id}:${key}`)!;
    expect(charge.amountCents).toBe(o.dueNowCents);
    const [pay] = await sql`select purpose, status, amount_cents from payments where idempotency_key = ${`number:${t.id}:${key}`}`;
    expect(pay).toEqual({ purpose: 'number', status: 'succeeded', amountCents: o.dueNowCents });
    const [row] = await sql`select provider_ref, paid_until from phone_numbers where id = ${body.number.id}`;
    expect(row!.providerRef).toBe(did.id);
    expect(new Date(body.number.paidUntil).getTime()).toBe(row!.paidUntil.getTime());
    // Calls to it reach this account (Kamailio's DID -> account view).
    expect(await sql`select tenant_id from kamailio_did_tenant where did_digits = ${o.number.slice(1)}`).toEqual([{ tenantId: t.id }]);

    const list = (await call(t.staff, 'GET', '/numbers')).json();
    expect(list.map((n: { did: string }) => n.did)).toEqual([o.number]);
    expect((await call(t.staff, 'GET', `/numbers/${body.number.id}`)).json().did).toBe(o.number);
    // It is gone from the offers.
    expect((await call(t.cookies, 'GET', '/numbers/available?areaCode=201&limit=50')).json().map((x: { id: string }) => x.id)).not.toContain(o.id);
  });

  it('replays a completed purchase for the same key, and refuses the key for another number', async () => {
    const t = await makeTenant();
    const o = await offer(t);
    const key = randomUUID();
    const first = await buy(t, o.id, key);
    expect(first.statusCode).toBe(201);
    const charges = stripe.charges.length;
    const again = await buy(t, o.id, key);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ number: { id: first.json().number.id }, chargedCents: first.json().chargedCents, replayed: true });
    expect(stripe.charges.length).toBe(charges);
    expect(ordersOf(o.number)).toBe(1);

    const other = await offer(t, 'areaCode=212');
    const reused = await buy(t, other.id, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error).toBe('idempotency_key_reused');
    // Keys are per account: another account may use the same string.
    const t2 = await makeTenant();
    expect((await buy(t2, other.id, key)).statusCode).toBe(201);
  });

  it('refuses a number someone else just bought, and replays that', async () => {
    const t = await makeTenant();
    const o = await offer(t, 'areaCode=973');
    provider.stolen.add(o.number);
    try {
      const key = randomUUID();
      const res = await buy(t, o.id, key);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('number_unavailable');
      expect((await buy(t, o.id, key)).json().error).toBe('number_unavailable');
      expect(ordersOf(o.number)).toBe(1);
    } finally {
      provider.stolen.delete(o.number);
    }
    expect((await buy(t, 'fake-does-not-exist')).json().error).toBe('number_unavailable');
  });

  it('needs a saved card, a paid plan and an account in good standing', async () => {
    const t = await makeTenant({ card: false });
    const o = await offer(t, 'areaCode=516');
    const key = randomUUID();
    const res = await buy(t, o.id, key);
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe('payment_required');
    expect(ordersOf(o.number)).toBe(0);
    // Not a final answer: after paying, the same key works.
    await payPlan(sql, t.id);
    await sql`update billing_accounts set payment_method_id = 'pm_card_visa' where tenant_id = ${t.id}`;
    expect((await buy(t, o.id, key)).statusCode).toBe(201);

    await sql`update tenants set status = 'past_due' where id = ${t.id}`;
    const pastDue = await buy(t, (await offer(t, 'areaCode=516')).id);
    expect(pastDue.statusCode).toBe(402);
    expect(pastDue.json().message).toMatch(/past due/);
  });

  it('declined card: nothing bought, the number goes back to the provider, the decline is replayed', async () => {
    const t = await makeTenant();
    const o = await offer(t, 'areaCode=631');
    stripe.declineWith = 'Your card was declined.';
    const key = randomUUID();
    const res = await buy(t, o.id, key);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'payment_failed', message: expect.stringContaining('declined') });
    expect(provider.owned.get(o.number)!.released).toBe(true);
    expect(await sql`select 1 from phone_numbers where did = ${o.number}`).toHaveLength(0);
    stripe.declineWith = null;
    expect((await buy(t, o.id, key)).statusCode).toBe(402); // a new card needs a new key
    expect(ordersOf(o.number)).toBe(1);
  });

  it('provider or payment service down: 502, then the same key finishes without ordering twice', async () => {
    const t = await makeTenant();
    const o = await offer(t, 'areaCode=212');
    const key = randomUUID();
    provider.down = true;
    const down = await buy(t, o.id, key);
    expect(down.statusCode).toBe(502);
    expect(down.json().error).toBe('did_provider_error');
    provider.down = false;

    stripe.down = true; // ordered and assigned, then the charge fails
    const noGateway = await buy(t, o.id, key);
    expect(noGateway.statusCode).toBe(502);
    expect(noGateway.json().error).toBe('payment_gateway_error');
    stripe.down = false;

    const ok = await buy(t, o.id, key);
    expect(ok.statusCode).toBe(201);
    expect(ordersOf(o.number)).toBe(1);
    expect(stripe.charges.filter((c) => c.key === `number:${t.id}:${key}`)).toHaveLength(1);
  });

  it('an order whose response was lost is found again instead of ordered twice', async () => {
    const t = await makeTenant();
    const o = await offer(t, 'areaCode=973');
    const key = randomUUID();
    const before = ordersOf(o.number); // an earlier test may have tried this number
    provider.loseNext = true;
    expect((await buy(t, o.id, key)).statusCode).toBe(502);
    const res = await buy(t, o.id, key);
    expect(res.statusCode).toBe(201);
    expect(res.json().number.did).toBe(o.number);
    expect(ordersOf(o.number)).toBe(before + 1);
  });

  it('answers 202 while the provider is still processing, then completes on retry', async () => {
    const t = await makeTenant();
    const o = await offer(t, 'kind=toll_free');
    const key = randomUUID();
    provider.pendingPolls = 2;
    const first = await buy(t, o.id, key);
    expect(first.statusCode).toBe(202);
    expect(first.headers['retry-after']).toBe('2');
    expect(first.json().status).toBe('processing');
    expect((await buy(t, o.id, key)).statusCode).toBe(202);
    const done = await buy(t, o.id, key);
    expect(done.statusCode).toBe(201);
    expect(done.json().number).toMatchObject({ did: o.number, kind: 'toll_free' });
    expect(done.json().chargedCents).toBeLessThanOrEqual(PRICES.tollFreeNumberCents);
    expect(ordersOf(o.number)).toBe(1);
  });

  it('refuses a second concurrent attempt with the same key', async () => {
    const t = await makeTenant();
    const key = randomUUID();
    await sql`
      insert into purchase_requests (idempotency_key, tenant_id, status, request)
      values (${`${t.id}:${key}`}, ${t.id}, 'pending', ${sql.json({ availableNumberId: 'fake-12015550149' })})`;
    const res = await buy(t, 'fake-12015550149', key);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('purchase_in_progress');
  });

  it('releases a number: kept until the paid period ends, not renewed, no longer routable', async () => {
    const t = await makeTenant();
    const o = await offer(t, 'areaCode=212');
    const n = (await buy(t, o.id)).json().number;
    expect((await call(t.staff, 'DELETE', `/numbers/${n.id}`)).statusCode).toBe(403);
    const other = await makeTenant();
    expect((await call(other.cookies, 'DELETE', `/numbers/${n.id}`)).statusCode).toBe(404);
    expect((await call(other.cookies, 'GET', `/numbers/${n.id}`)).statusCode).toBe(404);

    const res = await call(t.cookies, 'DELETE', `/numbers/${n.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: n.id, status: 'released', paidUntil: n.paidUntil });
    expect(provider.owned.get(o.number)!.released).toBe(true);
    // Its recurring item stops renewing (billing scheduler).
    const [item] = await sql`select price_cents, paid_through, removed_at from account_items where phone_number_id = ${n.id}`;
    expect(item).toMatchObject({ priceCents: PRICES.localNumberCents, paidThrough: new Date(n.paidUntil), removedAt: expect.any(Date) });
    // Still listed and still delivering calls until paidUntil.
    expect((await call(t.cookies, 'GET', '/numbers')).json().map((x: { id: string }) => x.id)).toContain(n.id);
    expect(await sql`select 1 from kamailio_did_tenant where did_digits = ${o.number.slice(1)}`).toHaveLength(1);
    // Still routable until paidUntil; releasing again is fine and doesn't call the provider.
    expect((await call(t.cookies, 'PUT', `/numbers/${n.id}/route`, { destination: null })).statusCode).toBe(200);
    const releases = provider.calls.filter(([op]) => op === 'release').length;
    expect((await call(t.cookies, 'DELETE', `/numbers/${n.id}`)).statusCode).toBe(200);
    expect(provider.calls.filter(([op]) => op === 'release').length).toBe(releases);
    // After the paid period it disappears from the list.
    await sql`update phone_numbers set paid_until = now() - interval '1 minute' where id = ${n.id}`;
    expect((await call(t.cookies, 'GET', '/numbers')).json().map((x: { id: string }) => x.id)).not.toContain(n.id);
    // ... and can't be routed any more.
    expect((await call(t.cookies, 'PUT', `/numbers/${n.id}/route`, { destination: null })).statusCode).toBe(404);
  });

  it('a released number blocks deleting its target only while it still routes calls', async () => {
    const t = await makeTenant();
    const n = (await buy(t, (await offer(t, 'areaCode=973')).id)).json().number;
    const mb = (await call(t.cookies, 'POST', '/mailboxes', { name: 'Released number target' })).json();
    const dest = { type: 'voicemail', id: mb.id };
    expect((await call(t.cookies, 'PUT', `/numbers/${n.id}/route`, { destination: dest })).statusCode).toBe(200);
    expect((await call(t.cookies, 'DELETE', `/numbers/${n.id}`)).statusCode).toBe(200);

    // During the paid period the number still delivers calls to the mailbox: refuse, naming it.
    const busy = await call(t.cookies, 'DELETE', `/mailboxes/${mb.id}`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().message).toContain(n.did);

    // Lapsed: it routes nothing any more, so it no longer blocks the delete.
    await sql`update phone_numbers set paid_until = now() - interval '1 minute' where id = ${n.id}`;
    expect((await call(t.cookies, 'DELETE', `/mailboxes/${mb.id}`)).statusCode).toBe(204);
  });
});
