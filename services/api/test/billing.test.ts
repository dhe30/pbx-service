import { randomUUID } from 'node:crypto';
import { billingPeriod, type Sql } from '@pbx/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { CEILINGS_CENTS, PLAN, PRICES, proratedCents } from '../src/billing/catalog.js';
import { FakeStripe, build, connectTestDb } from './helpers.js';

// Signup card + first plan charge + extension limit (docs/billing-flows.md §1, §3).

describe('catalog', () => {
  it('every price is under the course ceilings (cards decline anything above)', () => {
    expect(PLAN.priceCents).toBeLessThanOrEqual(CEILINGS_CENTS.perIncludedExtension * PLAN.includedExtensions);
    expect(PRICES.extensionCents).toBeLessThanOrEqual(CEILINGS_CENTS.extension);
    expect(PRICES.localNumberCents).toBeLessThanOrEqual(CEILINGS_CENTS.localNumber);
    expect(PRICES.tollFreeNumberCents).toBeLessThanOrEqual(CEILINGS_CENTS.tollFreeNumber);
    expect(PRICES.intlCallingCents).toBeLessThanOrEqual(CEILINGS_CENTS.intlCalling);
    expect(PRICES.recordingCents).toBeLessThanOrEqual(CEILINGS_CENTS.recording);
  });

  it('prorates linearly to the period end, never above the full price', () => {
    const start = new Date('2026-11-09T05:00:00Z');
    const end = new Date('2026-11-16T05:00:00Z');
    const p = { start, end };
    expect(proratedCents(1900, p, start)).toBe(1900);
    expect(proratedCents(1900, p, new Date('2026-11-12T17:00:00Z'))).toBe(950); // half way
    expect(proratedCents(1900, p, end)).toBe(0);
    expect(proratedCents(1900, p, new Date('2026-11-01T00:00:00Z'))).toBe(1900);
  });
});

describe('billing routes without a DB', () => {
  it('require login and the owner role', async () => {
    const app = await build();
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    for (const [method, url] of [
      ['GET', '/billing'],
      ['POST', '/billing/setup-intent'],
      ['POST', '/billing/card'],
    ] as const) {
      expect((await app.inject({ method, url, payload: {} })).statusCode, url).toBe(401);
      expect((await app.inject({ method, url, payload: {}, cookies: { [ACCESS_COOKIE]: staff } })).statusCode, url).toBe(403);
    }
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('signup card, plan charge, extension limit (Postgres)', () => {
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

  async function signup() {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { businessName: 'Billing test', timezone: 'America/Los_Angeles', email: `b-${randomUUID()}@example.test`, password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    tenantIds.push(body.tenantId);
    const cookies = { [ACCESS_COOKIE]: res.cookies.find((c) => c.name === ACCESS_COOKIE)!.value };
    const call = (method: 'GET' | 'POST', url: string, payload?: object): Promise<LightMyRequestResponse> =>
      app.inject({ method, url, payload, cookies });
    return { ...body, call };
  }
  const extension = (n: number) => ({ number: String(100 + n), name: `Ext ${n}` });

  it('signup -> Stripe.js saves the card -> POST /billing/card charges the prorated plan', async () => {
    const t = await signup();
    expect(t.cardSetup.clientSecret).toBe(`${t.cardSetup.setupIntentId}_secret`);

    const before = (await t.call('GET', '/billing')).json();
    expect(before).toMatchObject({ card: null, planPaidThrough: null, extensions: { used: 0, allowed: 2 } });
    const blocked = await t.call('POST', '/extensions', extension(1));
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error).toBe('payment_required');

    stripe.completeSetup(t.cardSetup.setupIntentId);
    const charges = stripe.charges.length;
    const saved = await t.call('POST', '/billing/card', { setupIntentId: t.cardSetup.setupIntentId });
    expect(saved.statusCode).toBe(200);
    const [tenant] = await sql<{ createdAt: Date }[]>`select created_at from tenants where id = ${t.tenantId}`;
    const period = billingPeriod('America/Los_Angeles', tenant!.createdAt, new Date());
    expect(saved.json()).toMatchObject({
      card: { brand: 'visa', last4: '4242' },
      planPaidThrough: period.end.toISOString(),
      currentPeriod: { start: period.start.toISOString(), end: period.end.toISOString() },
    });
    expect(stripe.charges.length).toBe(charges + 1);
    const charge = stripe.charges.at(-1)!;
    // Signed up today, so most of the first period is left: between 6/7 of the price and all of it.
    expect(charge.amountCents).toBeGreaterThan(Math.floor((PLAN.priceCents * 6) / 7));
    expect(charge.amountCents).toBeLessThanOrEqual(PLAN.priceCents);
    const [payment] = await sql`select purpose, amount_cents, status from payments where tenant_id = ${t.tenantId}`;
    expect(payment).toEqual({ purpose: 'plan', amountCents: charge.amountCents, status: 'succeeded' });

    // Retrying (lost response) charges nothing more.
    expect((await t.call('POST', '/billing/card', { setupIntentId: t.cardSetup.setupIntentId })).statusCode).toBe(200);
    expect(stripe.charges.length).toBe(charges + 1);

    // Plan includes 2 extensions.
    expect((await t.call('POST', '/extensions', extension(1))).statusCode).toBe(201);
    expect((await t.call('POST', '/extensions', extension(2))).statusCode).toBe(201);
    const third = await t.call('POST', '/extensions', extension(3));
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toBe('extension_limit');
    expect((await t.call('GET', '/billing')).json().extensions).toEqual({ used: 2, allowed: 2 });

    // Replacing the card later: new setup, no charge (the plan is paid).
    const setup = (await t.call('POST', '/billing/setup-intent')).json();
    expect(setup).toMatchObject({ publishableKey: 'pk_test_fake', stripeJsUrl: 'https://stripe.test/v3/' });
    stripe.completeSetup(setup.setupIntentId, { brand: 'mastercard', last4: '4444' });
    const replaced = await t.call('POST', '/billing/card', { setupIntentId: setup.setupIntentId });
    expect(replaced.json().card).toEqual({ brand: 'mastercard', last4: '4444' });
    expect(stripe.charges.length).toBe(charges + 1);
  });

  it('a declined plan charge is 402 and leaves the plan unpaid; another card then pays', async () => {
    const t = await signup();
    stripe.completeSetup(t.cardSetup.setupIntentId);
    stripe.declineWith = 'Your card was declined.';
    try {
      const res = await t.call('POST', '/billing/card', { setupIntentId: t.cardSetup.setupIntentId });
      expect(res.statusCode).toBe(402);
      expect(res.json()).toMatchObject({ error: 'payment_failed', message: expect.stringMatching(/Your card was declined/) });
    } finally {
      stripe.declineWith = null;
    }
    expect((await t.call('GET', '/billing')).json()).toMatchObject({ card: { last4: '4242' }, planPaidThrough: null });
    const [failed] = await sql`select status, failure_message from payments where tenant_id = ${t.tenantId}`;
    expect(failed).toEqual({ status: 'failed', failureMessage: 'Your card was declined.' });

    const setup = (await t.call('POST', '/billing/setup-intent')).json();
    stripe.completeSetup(setup.setupIntentId, { brand: 'visa', last4: '1881' });
    const paid = await t.call('POST', '/billing/card', { setupIntentId: setup.setupIntentId });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().planPaidThrough).not.toBeNull();
    const rows = await sql`select status from payments where tenant_id = ${t.tenantId} order by created_at`;
    expect(rows.map((r) => r.status)).toEqual(['failed', 'succeeded']);
  });

  it("refuses unconfirmed, unknown and other accounts' SetupIntents", async () => {
    const t = await signup();
    const other = await signup();
    const unconfirmed = await t.call('POST', '/billing/card', { setupIntentId: t.cardSetup.setupIntentId });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().error).toBe('card_not_saved');
    stripe.completeSetup(other.cardSetup.setupIntentId);
    const foreign = await t.call('POST', '/billing/card', { setupIntentId: other.cardSetup.setupIntentId });
    expect(foreign.json()).toEqual({ error: 'invalid_request', message: 'setupIntentId: no such card setup for this account' });
    const unknown = await t.call('POST', '/billing/card', { setupIntentId: 'seti_nope' });
    expect(unknown.statusCode).toBe(400);
    expect((await t.call('GET', '/billing')).json().planPaidThrough).toBeNull();
  });

  it('signup still succeeds when the gateway is down; card setup can be started later', async () => {
    stripe.down = true;
    let t: Awaited<ReturnType<typeof signup>>;
    try {
      t = await signup();
      expect(t.cardSetup).toBeNull();
      const res = await t.call('POST', '/billing/setup-intent');
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('payment_gateway_error');
    } finally {
      stripe.down = false;
    }
    expect((await t.call('POST', '/billing/setup-intent')).statusCode).toBe(201);
  });

  it('GET /billing/prices is public and shows the call_pricing per-minute prices', async () => {
    const res = await app.inject({ method: 'GET', url: '/billing/prices' });
    expect(res.statusCode).toBe(200);
    const [p] = await sql`select us_per_min from call_pricing`;
    expect(res.json()).toMatchObject({
      currency: 'usd',
      plan: { priceCents: PLAN.priceCents, includedExtensions: 2 },
      extensionCents: PRICES.extensionCents,
      perMinute: { usPerMin: Number(p!.usPerMin) },
    });
  });
});
