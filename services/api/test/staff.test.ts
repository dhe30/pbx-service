import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { build, connectTestDb, payPlan } from './helpers.js';

// Staff = dashboard logins. SIP accounts belong to extensions (extensions.test.ts).

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

  it('/me/sip-credentials requires login', async () => {
    const app = await build();
    expect((await app.inject({ method: 'GET', url: '/me/sip-credentials' })).statusCode).toBe(401);
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('staff (Postgres)', () => {
  const sql = db as Sql;
  let app: FastifyInstance;
  const tenants: string[] = [];

  async function makeTenant() {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('Staff test') returning id`;
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${t!.id}, ${`owner-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    tenants.push(t!.id);
    await payPlan(sql, t!.id);
    const cookie = app.jwt.sign({ sub: u!.id, tid: t!.id, role: 'owner', typ: 'access' });
    return { tenantId: t!.id, ownerId: u!.id, cookies: { [ACCESS_COOKIE]: cookie } };
  }

  const createStaff = (cookies: Record<string, string>, email = `staff-${randomUUID()}@example.test`) =>
    app.inject({ method: 'POST', url: '/staff', cookies, payload: { email, password: 'correct horse' } });

  beforeAll(async () => {
    app = await build({ sql });
  });

  afterAll(async () => {
    await sql`delete from kamailio.subscriber where tenant_id = any(${tenants})`;
    await sql`delete from tenants where id = any(${tenants}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('POST /staff creates a login (no SIP account); the staff member can log in', async () => {
    const a = await makeTenant();
    const email = `Staff-${randomUUID()}@Example.test`;
    const res = await createStaff(a.cookies, email);
    expect(res.statusCode).toBe(201);
    const staff = res.json();
    expect(staff).toMatchObject({ email: email.toLowerCase(), role: 'staff' });
    expect(Object.keys(staff).sort()).toEqual(['createdAt', 'email', 'id', 'role']);

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'correct horse' } });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ userId: staff.id, tenantId: a.tenantId, role: 'staff' });
  });

  it('POST /staff: 400 on bad input, 409 on a taken email', async () => {
    const a = await makeTenant();
    const bad = await app.inject({ method: 'POST', url: '/staff', cookies: a.cookies, payload: { email: 'nope', password: 'short' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/email: .*password: /);
    const email = `dup-${randomUUID()}@example.test`;
    expect((await createStaff(a.cookies, email)).statusCode).toBe(201);
    const dup = await createStaff(a.cookies, email);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('email_taken');
  });

  it("GET /staff lists only this tenant's staff, never owners or secrets", async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const s1 = (await createStaff(a.cookies)).json();
    const s2 = (await createStaff(a.cookies)).json();
    await createStaff(b.cookies);
    const res = await app.inject({ method: 'GET', url: '/staff', cookies: a.cookies });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { id: string }[]).map((s) => s.id)).toEqual([s1.id, s2.id]);
  });

  it('DELETE /staff/:id removes the login; an extension assigned to them keeps working, unassigned', async () => {
    const a = await makeTenant();
    const staff = (await createStaff(a.cookies)).json();
    const ext = await app.inject({
      method: 'POST',
      url: '/extensions',
      cookies: a.cookies,
      payload: { number: '101', name: 'Front desk', userId: staff.id },
    });
    expect(ext.statusCode).toBe(201);
    const res = await app.inject({ method: 'DELETE', url: `/staff/${staff.id}`, cookies: a.cookies });
    expect(res.statusCode).toBe(204);
    expect(await sql`select 1 from users where id = ${staff.id}`).toHaveLength(0);
    const [e] = await sql<{ userId: string | null }[]>`select user_id from extensions where id = ${ext.json().id}`;
    expect(e!.userId).toBeNull();
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
});
