import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { build, connectTestDb, testConfig, payPlan } from './helpers.js';

// Course spec §3 "Extensions": number unique in the account, name, SIP username and password
// (returned by the API), voicemail box, forwarding (always, busy, no answer) to an extension or
// external number. §4: a logged-in user calls and answers as one of the account's extensions.

describe('extension routes without a DB', () => {
  it('reads need login; writes need the owner role', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/extensions' })).statusCode).toBe(401);
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    for (const [method, url] of [
      ['POST', '/extensions'],
      ['PUT', `/extensions/${randomUUID()}`],
      ['DELETE', `/extensions/${randomUUID()}`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {}, cookies: { [ACCESS_COOKIE]: staff } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

const db = await connectTestDb();
const hasKamailio = db ? (await db`select to_regclass('kamailio.subscriber') as t`)[0]!.t !== null : false;

describe.skipIf(!db || !hasKamailio)('extensions + SIP credentials (Postgres)', () => {
  const sql = db as Sql;
  let app: FastifyInstance;
  const tenants: string[] = [];

  async function makeTenant() {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('Ext test') returning id`;
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${t!.id}, ${`owner-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    const [s] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${t!.id}, ${`staff-${randomUUID()}@example.test`}, '!', 'staff') returning id`;
    tenants.push(t!.id);
    await payPlan(sql, t!.id);
    const did = `+1201${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    await sql`insert into phone_numbers (did, tenant_id, provider_ref) values (${did}, ${t!.id}, 'test')`;
    return {
      tenantId: t!.id,
      did,
      staffId: s!.id,
      owner: { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: t!.id, role: 'owner', typ: 'access' }) },
      staff: { [ACCESS_COOKIE]: app.jwt.sign({ sub: s!.id, tid: t!.id, role: 'staff', typ: 'access' }) },
    };
  }
  type T = Awaited<ReturnType<typeof makeTenant>>;
  const create = (t: T, body: object) => app.inject({ method: 'POST', url: '/extensions', cookies: t.owner, payload: body });

  beforeAll(async () => {
    app = await build({ sql });
  });

  afterAll(async () => {
    await sql`delete from kamailio.subscriber where tenant_id = any(${tenants})`;
    await sql`delete from phone_numbers where tenant_id = any(${tenants}::uuid[])`;
    await sql`delete from tenants where id = any(${tenants}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('POST creates the extension, its mailbox and its SIP account (one transaction); returns the credentials', async () => {
    const a = await makeTenant();
    const res = await create(a, { number: '101', name: 'Front desk' });
    expect(res.statusCode).toBe(201);
    const ext = res.json();
    expect(ext).toMatchObject({ number: '101', name: 'Front desk', ringTimeoutSec: 20, externalNumbers: [], forwardAlways: null });
    expect(ext.sipUsername).toMatch(/^x[0-9a-f]{16}$/);
    expect(ext.sipPassword).toHaveLength(24);
    const [sub] = await sql`select domain, password, tenant_id, extension_id from kamailio.subscriber where username = ${ext.sipUsername}`;
    expect(sub).toEqual({ domain: testConfig.SIP_DOMAIN, password: ext.sipPassword, tenantId: a.tenantId, extensionId: ext.id });
    const [mb] = await sql`select name from mailboxes where id = ${ext.mailboxId}`;
    expect(mb!.name).toBe('Front desk (101)');
  });

  it('mailboxId null = no voicemail box; an explicit mailbox must be the tenant’s', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    expect((await create(a, { number: '101', name: 'x', mailboxId: null })).json().mailboxId).toBeNull();
    const [bMb] = await sql<{ id: string }[]>`insert into mailboxes (tenant_id, name) values (${b.tenantId}, 'B') returning id`;
    const res = await create(a, { number: '102', name: 'x', mailboxId: bMb!.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('mailboxId: no such mailbox');
  });

  it('number unique per account (409), reusable in another account; digits only (400)', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    expect((await create(a, { number: '101', name: 'x' })).statusCode).toBe(201);
    const dup = await create(a, { number: '101', name: 'y' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('number_taken');
    expect((await create(b, { number: '101', name: 'x' })).statusCode).toBe(201);
    expect((await create(a, { number: '10a', name: 'x' })).statusCode).toBe(400);
  });

  it('forwarding to another extension or an external number; references checked', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const target = (await create(a, { number: '102', name: 'target' })).json();
    const bExt = (await create(b, { number: '200', name: 'other' })).json();
    const ok = await create(a, {
      number: '101',
      name: 'fwd',
      forwardBusy: { type: 'extension', id: target.id },
      forwardNoAnswer: { type: 'external', number: '+12015550123' },
      externalNumbers: ['+12015550199'],
      callerIdNumber: a.did,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ forwardBusy: { type: 'extension', id: target.id }, callerIdNumber: a.did });
    const cross = await create(a, { number: '103', name: 'x', forwardAlways: { type: 'extension', id: bExt.id } });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().message).toBe('forwardAlways.id: no such extension');
    const badType = await create(a, { number: '104', name: 'x', forwardAlways: { type: 'ring_group', id: target.id } });
    expect(badType.statusCode).toBe(400);
    const notOurs = await create(a, { number: '105', name: 'x', callerIdNumber: '+19995550000' });
    expect(notOurs.statusCode).toBe(400);
    expect(notOurs.json().message).toMatch(/callerIdNumber/);
    expect((await create(a, { number: '106', name: 'x', externalNumbers: ['2015550123'] })).statusCode).toBe(400);
  });

  it('GET: owners see SIP passwords, staff do not; other tenants get 404', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const ext = (await create(a, { number: '101', name: 'x' })).json();
    const asOwner = await app.inject({ method: 'GET', url: '/extensions', cookies: a.owner });
    expect(asOwner.json()[0].sipPassword).toBe(ext.sipPassword);
    const asStaff = await app.inject({ method: 'GET', url: '/extensions', cookies: a.staff });
    expect(asStaff.json()[0]).not.toHaveProperty('sipPassword');
    expect((await app.inject({ method: 'GET', url: `/extensions/${ext.id}`, cookies: b.owner })).statusCode).toBe(404);
  });

  it('PUT replaces settings and keeps the mailbox when mailboxId is omitted; 404 for another tenant', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const ext = (await create(a, { number: '101', name: 'x' })).json();
    const res = await app.inject({
      method: 'PUT',
      url: `/extensions/${ext.id}`,
      cookies: a.owner,
      payload: { number: '111', name: 'Renamed', ringTimeoutSec: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ number: '111', name: 'Renamed', ringTimeoutSec: 30, mailboxId: ext.mailboxId, sipUsername: ext.sipUsername });
    const other = await app.inject({ method: 'PUT', url: `/extensions/${ext.id}`, cookies: b.owner, payload: { number: '1', name: 'x' } });
    expect(other.statusCode).toBe(404);
  });

  it('GET /me/sip-credentials: the assigned extension by default, any extension of the account by id', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const mine = (await create(a, { number: '101', name: 'mine', userId: a.staffId })).json();
    const other = (await create(a, { number: '102', name: 'other' })).json();
    const bExt = (await create(b, { number: '200', name: 'b' })).json();

    const def = await app.inject({ method: 'GET', url: '/me/sip-credentials', cookies: a.staff });
    expect(def.statusCode).toBe(200);
    expect(def.headers['cache-control']).toBe('no-store');
    expect(def.json()).toEqual({
      wsUri: testConfig.SIP_WS_URI,
      sipUri: `sip:${mine.sipUsername}@${testConfig.SIP_DOMAIN}`,
      username: mine.sipUsername,
      password: mine.sipPassword,
      extensionId: mine.id,
      extensionNumber: '101',
    });
    const chosen = await app.inject({ method: 'GET', url: `/me/sip-credentials?extensionId=${other.id}`, cookies: a.owner });
    expect(chosen.json().username).toBe(other.sipUsername);
    const cross = await app.inject({ method: 'GET', url: `/me/sip-credentials?extensionId=${bExt.id}`, cookies: a.staff });
    expect(cross.statusCode).toBe(404);
    const none = await app.inject({ method: 'GET', url: '/me/sip-credentials', cookies: a.owner });
    expect(none.statusCode).toBe(404); // the owner has no assigned extension
  });

  it('DELETE removes extension + SIP account; 409 while something routes to it', async () => {
    const a = await makeTenant();
    const ext = (await create(a, { number: '101', name: 'x' })).json();
    const fwd = (await create(a, { number: '102', name: 'fwd', forwardAlways: { type: 'extension', id: ext.id } })).json();
    const busy = await app.inject({ method: 'DELETE', url: `/extensions/${ext.id}`, cookies: a.owner });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'in_use', message: 'Used by extension "102"; change that first' });

    expect((await app.inject({ method: 'DELETE', url: `/extensions/${fwd.id}`, cookies: a.owner })).statusCode).toBe(204);
    const res = await app.inject({ method: 'DELETE', url: `/extensions/${ext.id}`, cookies: a.owner });
    expect(res.statusCode).toBe(204);
    expect(await sql`select 1 from kamailio.subscriber where username = ${ext.sipUsername}`).toHaveLength(0);
    expect(await sql`select 1 from mailboxes where id = ${ext.mailboxId}`).toHaveLength(1); // voicemails kept
  });

  it("DELETE refuses a ring group's only member, and leaves groups with other members", async () => {
    const a = await makeTenant();
    const one = (await create(a, { number: '201', name: 'one' })).json();
    const two = (await create(a, { number: '202', name: 'two' })).json();
    const group = (key: string, memberIds: string[]) =>
      app.inject({ method: 'POST', url: '/ring-groups', cookies: a.owner, payload: { name: key, strategy: 'all', memberIds } });
    const solo = (await group('Solo', [one.id])).json();
    const shared = (await group('Shared', [one.id, two.id])).json();

    const refused = await app.inject({ method: 'DELETE', url: `/extensions/${one.id}`, cookies: a.owner });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'in_use', message: 'Used by ring group "Solo" (its only member); change that first' });

    expect((await app.inject({ method: 'DELETE', url: `/ring-groups/${solo.id}`, cookies: a.owner })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/extensions/${one.id}`, cookies: a.owner })).statusCode).toBe(204);
    const after = (await app.inject({ method: 'GET', url: `/ring-groups/${shared.id}`, cookies: a.owner })).json();
    expect(after.memberIds).toEqual([two.id]);
  });
});
