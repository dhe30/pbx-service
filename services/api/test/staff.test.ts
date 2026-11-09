import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { build, connectTestDb, testConfig } from './helpers.js';

describe('staff routes without a DB', () => {
  it('require login, and the owner role (staff -> 403)', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/staff' })).statusCode).toBe(401);
    const staffToken = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    for (const [method, url] of [
      ['GET', '/staff'],
      ['POST', '/staff'],
      ['DELETE', `/staff/${randomUUID()}`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {}, cookies: { [ACCESS_COOKIE]: staffToken } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('/me/sip-credentials is staff-only (owner -> 403)', async () => {
    const app = await build();
    const ownerToken = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'owner', typ: 'access' });
    const res = await app.inject({
      method: 'GET',
      url: '/me/sip-credentials',
      cookies: { [ACCESS_COOKIE]: ownerToken },
    });
    expect(res.statusCode).toBe(403);
  });
});

const db = await connectTestDb();
// The Kamailio tables come from `npm run db:kamailio` locally (db_schema Ansible role in prod).
const hasKamailio = db ? (await db`select to_regclass('kamailio.subscriber') as t`)[0]!.t !== null : false;

describe.skipIf(!db || !hasKamailio)('staff + SIP credentials (Postgres)', () => {
  const sql = db as Sql;
  let app: FastifyInstance;
  const tenants: string[] = [];
  const createdSip: string[] = [];

  async function makeTenant() {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('Staff test') returning id`;
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${t!.id}, ${`owner-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    tenants.push(t!.id);
    const cookie = app.jwt.sign({ sub: u!.id, tid: t!.id, role: 'owner', typ: 'access' });
    return { tenantId: t!.id, ownerId: u!.id, cookies: { [ACCESS_COOKIE]: cookie } };
  }

  async function createStaff(cookies: Record<string, string>, email = `staff-${randomUUID()}@example.test`) {
    const res = await app.inject({
      method: 'POST',
      url: '/staff',
      cookies,
      payload: { email, password: 'correct horse' },
    });
    if (res.statusCode === 201) createdSip.push(res.json().sipUsername);
    return res;
  }

  const staffCookies = (userId: string, tenantId: string) => ({
    [ACCESS_COOKIE]: app.jwt.sign({ sub: userId, tid: tenantId, role: 'staff', typ: 'access' }),
  });

  beforeAll(async () => {
    app = await build({ sql });
  });

  afterAll(async () => {
    await sql`delete from kamailio.location where username = any(${createdSip})`;
    await sql`delete from kamailio.subscriber where username = any(${createdSip})`;
    await sql`delete from tenants where id = any(${tenants}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('POST /staff creates the user and its subscriber row; the staff member can log in', async () => {
    const a = await makeTenant();
    const email = `Staff-${randomUUID()}@Example.test`;
    const res = await createStaff(a.cookies, email);
    expect(res.statusCode).toBe(201);
    const staff = res.json();
    expect(staff).toMatchObject({ email: email.toLowerCase(), role: 'staff' });
    expect(staff.sipUsername).toMatch(/^s[0-9a-f]{16}$/);
    expect(staff).not.toHaveProperty('password');
    expect(staff).not.toHaveProperty('passwordHash');

    const [sub] = await sql`select domain, password from kamailio.subscriber where username = ${staff.sipUsername}`;
    expect(sub!.domain).toBe(testConfig.SIP_DOMAIN);
    expect(sub!.password).toHaveLength(24);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'correct horse' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ userId: staff.id, tenantId: a.tenantId, role: 'staff' });
  });

  it('POST /staff: 400 on bad input, 409 on a taken email (and no subscriber row left behind)', async () => {
    const a = await makeTenant();
    const bad = await app.inject({
      method: 'POST',
      url: '/staff',
      cookies: a.cookies,
      payload: { email: 'nope', password: 'short' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/email: .*password: /);

    const email = `dup-${randomUUID()}@example.test`;
    expect((await createStaff(a.cookies, email)).statusCode).toBe(201);
    const [{ count: before }] = (await sql`select count(*)::int as count from kamailio.subscriber`) as unknown as [
      { count: number },
    ];
    const dup = await createStaff(a.cookies, email);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('email_taken');
    const [{ count: after }] = (await sql`select count(*)::int as count from kamailio.subscriber`) as unknown as [
      { count: number },
    ];
    expect(after).toBe(before);
  });

  it("GET /staff lists only this tenant's staff, never owners or secrets", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const s1 = (await createStaff(a.cookies)).json();
    const s2 = (await createStaff(a.cookies)).json();
    await createStaff(b.cookies);

    const res = await app.inject({ method: 'GET', url: '/staff', cookies: a.cookies });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Record<string, unknown>[];
    expect(list.map((s) => s.id)).toEqual([s1.id, s2.id]);
    expect(Object.keys(list[0]!).sort()).toEqual(['createdAt', 'email', 'id', 'role', 'sipUsername']);
  });

  it('GET /me/sip-credentials returns the SIP account, uncached', async () => {
    const a = await makeTenant();
    const staff = (await createStaff(a.cookies)).json();
    const res = await app.inject({
      method: 'GET',
      url: '/me/sip-credentials',
      cookies: staffCookies(staff.id, a.tenantId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const [sub] = await sql`select password from kamailio.subscriber where username = ${staff.sipUsername}`;
    expect(res.json()).toEqual({
      wsUri: testConfig.SIP_WS_URI,
      sipUri: `sip:${staff.sipUsername}@${testConfig.SIP_DOMAIN}`,
      username: staff.sipUsername,
      password: sub!.password,
    });
  });

  it('DELETE /staff/:id removes user, subscriber, registrations and ring group membership', async () => {
    const a = await makeTenant();
    const staff = (await createStaff(a.cookies)).json();
    await sql`insert into kamailio.location (ruid, username, contact) values (${randomUUID()}, ${staff.sipUsername}, 'sip:x@1.2.3.4')`;
    const [rg] = await sql<{ id: string }[]>`
      insert into ring_groups (tenant_id, name) values (${a.tenantId}, 'All') returning id`;
    await sql`insert into ring_group_members (ring_group_id, user_id) values (${rg!.id}, ${staff.id})`;

    const res = await app.inject({ method: 'DELETE', url: `/staff/${staff.id}`, cookies: a.cookies });
    expect(res.statusCode).toBe(204);
    expect(await sql`select 1 from users where id = ${staff.id}`).toHaveLength(0);
    expect(await sql`select 1 from kamailio.subscriber where username = ${staff.sipUsername}`).toHaveLength(0);
    expect(await sql`select 1 from kamailio.location where username = ${staff.sipUsername}`).toHaveLength(0);
    expect(await sql`select 1 from ring_group_members where user_id = ${staff.id}`).toHaveLength(0);

    // Their still-valid access token no longer yields credentials.
    const creds = await app.inject({
      method: 'GET',
      url: '/me/sip-credentials',
      cookies: staffCookies(staff.id, a.tenantId),
    });
    expect(creds.statusCode).toBe(404);
  });

  it("DELETE /staff/:id: another tenant's staff, an owner, or an unknown id are all 404", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const bStaff = (await createStaff(b.cookies)).json();
    const responses = [];
    for (const id of [bStaff.id, a.ownerId, randomUUID()]) {
      responses.push(await app.inject({ method: 'DELETE', url: `/staff/${id}`, cookies: a.cookies }));
    }
    for (const r of responses) expect(r.statusCode).toBe(404);
    expect(responses[0]!.json()).toEqual(responses[2]!.json());
    expect(await sql`select 1 from users where id = ${bStaff.id}`).toHaveLength(1);
    expect(await sql`select 1 from users where id = ${a.ownerId}`).toHaveLength(1);
  });

  it('DELETE /staff/:id is 409 while an IVR menu routes a digit to that user', async () => {
    const a = await makeTenant();
    const staff = (await createStaff(a.cookies)).json();
    const config = { options: { '0': { action: 'user', target: staff.id } } };
    await sql`insert into ivr_menus (tenant_id, name, config) values (${a.tenantId}, 'Main menu', ${sql.json(config)})`;

    const res = await app.inject({ method: 'DELETE', url: `/staff/${staff.id}`, cookies: a.cookies });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'in_use',
      message: 'Used by IVR menu "Main menu"; change that first',
    });
    expect(await sql`select 1 from kamailio.subscriber where username = ${staff.sipUsername}`).toHaveLength(1);
  });
});
