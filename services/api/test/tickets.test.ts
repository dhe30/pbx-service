import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { registry } from '../src/metrics.js';
import { build, connectTestDb } from './helpers.js';

// Support tickets (course spec §3): account users open / list / close; the provider sees the
// open tickets of every account through the operator token.

const OPERATOR_TOKEN = 'operator-test-token-0123456789abcdef';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('ticket routes without a DB', () => {
  it('require login', async () => {
    const app = await build({}, { OPERATOR_TOKEN });
    const id = randomUUID();
    for (const [method, url] of [
      ['POST', '/tickets'],
      ['GET', '/tickets'],
      ['GET', '/tickets/summary'],
      ['GET', `/tickets/${id}`],
      ['POST', `/tickets/${id}/close`],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('operator routes refuse a missing or wrong token, and a customer cookie', async () => {
    const app = await build({}, { OPERATOR_TOKEN });
    const customer = { [ACCESS_COOKIE]: app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'owner', typ: 'access' }) };
    for (const url of ['/operator/tickets', `/operator/tickets/${randomUUID()}`]) {
      for (const opts of [
        {},
        { headers: bearer('wrong') },
        { headers: bearer(`${OPERATOR_TOKEN}x`) },
        { headers: { authorization: OPERATOR_TOKEN } }, // no "Bearer "
        { cookies: customer },
      ]) {
        const res = await app.inject({ method: 'GET', url, ...opts });
        expect(res.statusCode, `${url} ${JSON.stringify(opts)}`).toBe(401);
        expect(res.json().error).toBe('unauthorized');
      }
    }
  });

  it('operator routes refuse everyone when OPERATOR_TOKEN is not set', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/operator/tickets', headers: bearer('') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/operator/tickets', headers: bearer('undefined') })).statusCode).toBe(401);
  });

  it('are in the OpenAPI document, operator routes with the bearer scheme', async () => {
    const app = await build();
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(Object.keys(doc.paths['/tickets'])).toEqual(expect.arrayContaining(['get', 'post']));
    expect(doc.paths['/tickets/summary'].get.security).toEqual([{ cookieAuth: [] }]);
    expect(doc.paths['/tickets/{id}/close'].post.security).toEqual([{ cookieAuth: [] }]);
    expect(doc.paths['/tickets'].post.requestBody.content['application/json'].schema.required).toEqual(['subject', 'description']);
    expect(doc.paths['/operator/tickets'].get.security).toEqual([{ operatorAuth: [] }]);
    expect(doc.paths['/operator/tickets/{id}'].get.responses['401']).toBeDefined();
    expect(doc.components.securitySchemes.operatorAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('support tickets (Postgres)', () => {
  const sql = db as Sql;
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  interface User {
    id: string;
    email: string;
    cookies: Record<string, string>;
  }
  interface Tenant {
    id: string;
    name: string;
    owner: User;
    staff: User;
  }
  let a: Tenant;
  let b: Tenant;

  async function makeTenant(): Promise<Tenant> {
    const name = `Tickets test ${randomUUID().slice(0, 8)}`;
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values (${name}) returning id`;
    const tenantId = t!.id;
    tenantIds.push(tenantId);
    const user = async (role: 'owner' | 'staff'): Promise<User> => {
      const email = `${role}-${randomUUID()}@example.test`;
      const [u] = await sql<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, role) values (${tenantId}, ${email}, '!', ${role}) returning id`;
      return { id: u!.id, email, cookies: { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: tenantId, role, typ: 'access' }) } };
    };
    return { id: tenantId, name, owner: await user('owner'), staff: await user('staff') };
  }

  const call = (u: User, method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: u.cookies });
  const operator = (url: string) => app.inject({ method: 'GET', url, headers: bearer(OPERATOR_TOKEN) });
  const open = async (u: User, subject: string) => {
    const res = await call(u, 'POST', '/tickets', { subject, description: `Details of ${subject}` });
    expect(res.statusCode, res.body).toBe(201);
    // PGlite's clock may only have millisecond resolution: keep created_at distinct so "newest
    // first" assertions don't depend on the random-id tie-break.
    await new Promise((r) => setTimeout(r, 3));
    return res.json() as { id: string; status: string };
  };
  const ids = (res: { json(): { items: { id: string }[] } }) => res.json().items.map((t) => t.id);
  const counter = async (name: string) => (await registry.getSingleMetric(name)!.get()).values[0]?.value ?? 0;

  beforeAll(async () => {
    app = await build({ sql }, { OPERATOR_TOKEN });
    a = await makeTenant();
    b = await makeTenant();
  });

  afterAll(async () => {
    await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('any user opens a ticket; it starts open', async () => {
    const before = await counter('pbx_api_support_tickets_opened_total');
    const res = await call(a.staff, 'POST', '/tickets', { subject: '  Calls drop  ', description: 'After 30 s every call drops.' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      subject: 'Calls drop',
      description: 'After 30 s every call drops.',
      status: 'open',
      createdAt: expect.any(String),
      createdBy: a.staff.id,
      createdByEmail: a.staff.email,
      closedAt: null,
      closedBy: null,
    });
    expect(await counter('pbx_api_support_tickets_opened_total')).toBe(before + 1);
  });

  it('validates subject and description', async () => {
    for (const body of [
      {},
      { subject: 'x' },
      { description: 'x' },
      { subject: '   ', description: 'x' },
      { subject: 'x', description: '' },
      { subject: 'x'.repeat(201), description: 'x' },
      { subject: 'x', description: 'x'.repeat(10_001) },
      { subject: 'x', description: 'x', status: 'closed' }, // unknown fields are refused
    ]) {
      const res = await call(a.owner, 'POST', '/tickets', body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
  });

  it("lists the account's tickets newest first, filtered by status, with keyset paging", async () => {
    const [t1, t2, t3] = [await open(a.owner, 'one'), await open(a.staff, 'two'), await open(a.owner, 'three')];
    await open(b.owner, 'other account');
    await call(a.owner, 'POST', `/tickets/${t2.id}/close`);

    const all = await call(a.staff, 'GET', '/tickets?limit=200');
    expect(all.statusCode).toBe(200);
    const listed = ids(all);
    expect(listed.indexOf(t3.id)).toBeLessThan(listed.indexOf(t2.id));
    expect(listed.indexOf(t2.id)).toBeLessThan(listed.indexOf(t1.id));
    const [bOnly] = await sql<{ id: string }[]>`select id from support_tickets where tenant_id = ${b.id}`;
    expect(listed).not.toContain(bOnly!.id);
    expect(all.json().nextCursor).toBeNull();

    const openOnly = ids(await call(a.owner, 'GET', '/tickets?status=open&limit=200'));
    expect(openOnly).toEqual(expect.arrayContaining([t1.id, t3.id]));
    expect(openOnly).not.toContain(t2.id);
    expect(ids(await call(a.owner, 'GET', '/tickets?status=closed'))).toEqual([t2.id]);

    // Page through 1 at a time: same order, nothing repeated or skipped.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await call(a.owner, 'GET', `/tickets?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      paged.push(...ids(res));
      cursor = res.json().nextCursor;
    } while (cursor);
    expect(paged).toEqual(listed);

    expect((await call(a.owner, 'GET', '/tickets?status=pending')).statusCode).toBe(400);
    expect((await call(a.owner, 'GET', '/tickets?cursor=bogus')).statusCode).toBe(400);
  });

  it("returns account-wide open and closed counts regardless of list filters", async () => {
    await open(a.owner, 'summary open');
    const closed = await open(a.staff, 'summary closed');
    await call(a.owner, 'POST', `/tickets/${closed.id}/close`);
    await open(b.owner, 'other account summary');

    const res = await call(a.staff, 'GET', '/tickets/summary');
    expect(res.statusCode).toBe(200);
    const [expected] = await sql<{ open: number; closed: number }[]>`
      select count(*) filter (where status = 'open')::int as open,
             count(*) filter (where status = 'closed')::int as closed
        from support_tickets where tenant_id = ${a.id}`;
    expect(res.json()).toEqual(expected);
    expect(res.json().open).toBeGreaterThan(0);
    expect(res.json().closed).toBeGreaterThan(0);
  });

  it('gets one ticket; other accounts and unknown ids are 404', async () => {
    const t = await open(a.owner, 'get me');
    const res = await call(a.staff, 'GET', `/tickets/${t.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.id, subject: 'get me', createdBy: a.owner.id });
    expect(res.json()).not.toHaveProperty('tenantId');
    expect((await call(b.owner, 'GET', `/tickets/${t.id}`)).statusCode).toBe(404);
    expect((await call(a.owner, 'GET', `/tickets/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call(a.owner, 'GET', '/tickets/not-a-uuid')).statusCode).toBe(400);
  });

  it('closes a ticket, idempotently; another account cannot close it', async () => {
    const t = await open(a.owner, 'close me');
    expect((await call(b.owner, 'POST', `/tickets/${t.id}/close`)).statusCode).toBe(404);
    expect((await call(a.owner, 'GET', `/tickets/${t.id}`)).json().status).toBe('open');

    const before = await counter('pbx_api_support_tickets_closed_total');
    const first = await call(a.staff, 'POST', `/tickets/${t.id}/close`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: t.id, status: 'closed', closedAt: expect.any(String), closedBy: a.staff.id });

    const again = await call(a.owner, 'POST', `/tickets/${t.id}/close`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json()); // closedAt / closedBy unchanged
    expect(await counter('pbx_api_support_tickets_closed_total')).toBe(before + 1);

    expect((await call(a.owner, 'POST', `/tickets/${randomUUID()}/close`)).statusCode).toBe(404);
  });

  it("keeps a ticket when its creator is deleted; a deleted user's token opens it with createdBy null", async () => {
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${a.id}, ${`gone-${randomUUID()}@example.test`}, '!', 'staff') returning id`;
    const gone: User = { id: u!.id, email: '', cookies: { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: a.id, role: 'staff', typ: 'access' }) } };
    const t = await open(gone, 'mine');
    await sql`delete from users where id = ${gone.id}`;
    expect((await call(a.owner, 'GET', `/tickets/${t.id}`)).json()).toMatchObject({ createdBy: null, createdByEmail: null });

    const late = await call(gone, 'POST', '/tickets', { subject: 'after delete', description: 'still valid token' });
    expect(late.statusCode).toBe(201);
    expect(late.json().createdBy).toBeNull();
  });

  it('the operator sees the open tickets of every account, newest first, with the account', async () => {
    const ta = await open(a.staff, 'operator sees a');
    const tb = await open(b.owner, 'operator sees b');
    const closed = await open(a.owner, 'operator closed');
    await call(a.owner, 'POST', `/tickets/${closed.id}/close`);

    const res = await operator('/operator/tickets?limit=200');
    expect(res.statusCode).toBe(200);
    const items = (res.json().items as { id: string; status: string; tenantId: string }[]).filter((t) => tenantIds.includes(t.tenantId));
    expect(items.every((t) => t.status === 'open')).toBe(true);
    const listed = items.map((t) => t.id);
    expect(listed.slice(0, 2)).toEqual([tb.id, ta.id]); // newest first, across accounts
    expect(listed).not.toContain(closed.id);
    expect(items.find((t) => t.id === tb.id)).toMatchObject({
      tenantId: b.id,
      tenantName: b.name,
      subject: 'operator sees b',
      createdByEmail: b.owner.email,
    });

    const closedOnly = (await operator('/operator/tickets?status=closed&limit=200')).json().items.map((t: { id: string }) => t.id);
    expect(closedOnly).toContain(closed.id);
    expect(closedOnly).not.toContain(ta.id);
    const all = (await operator('/operator/tickets?status=all&limit=200')).json().items.map((t: { id: string }) => t.id);
    expect(all).toEqual(expect.arrayContaining([ta.id, tb.id, closed.id]));

    // Paging (limit 1) walks the same open list.
    const first = await operator('/operator/tickets?limit=1');
    expect(first.json().items).toHaveLength(1);
    const second = await operator(`/operator/tickets?limit=1&cursor=${first.json().nextCursor}`);
    expect(second.json().items[0].id).not.toBe(first.json().items[0].id);
  });

  it('the operator gets any ticket by id', async () => {
    const t = await open(b.staff, 'by id');
    const res = await operator(`/operator/tickets/${t.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.id, tenantId: b.id, tenantName: b.name, status: 'open' });
    expect((await operator(`/operator/tickets/${randomUUID()}`)).statusCode).toBe(404);
  });

  it('tickets go away with their account', async () => {
    const c = await makeTenant();
    const t = await open(c.owner, 'cascade');
    await sql`delete from tenants where id = ${c.id}`;
    expect((await operator(`/operator/tickets/${t.id}`)).statusCode).toBe(404);
  });
});
