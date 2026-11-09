import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACCESS_COOKIE, REFRESH_COOKIE, authenticate, requireRole } from '../src/auth.js';
import { build, connectTestDb } from './helpers.js';

/** Value of a Set-Cookie from an inject() response. */
function cookie(res: LightMyRequestResponse, name: string) {
  return res.cookies.find((c) => c.name === name);
}

/** App with test-only routes protected by authenticate / requireRole. */
async function buildWithProtectedRoutes(deps: Parameters<typeof build>[0] = {}): Promise<FastifyInstance> {
  const app = await build(deps);
  app.get('/test/whoami', { preHandler: authenticate }, async (req) => req.auth);
  app.get('/test/owner-only', { preHandler: [authenticate, requireRole('owner')] }, async () => ({ ok: true }));
  return app;
}

function sign(app: FastifyInstance, typ: 'access' | 'refresh', role: 'owner' | 'staff' = 'owner') {
  return app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role, typ }, { expiresIn: 900 });
}

describe('authenticate / requireRole (no DB)', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects a request without a cookie', async () => {
    const app = await buildWithProtectedRoutes();
    const res = await app.inject({ method: 'GET', url: '/test/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('accepts a valid access token and exposes req.auth', async () => {
    const app = await buildWithProtectedRoutes();
    const token = sign(app, 'access', 'staff');
    const res = await app.inject({ method: 'GET', url: '/test/whoami', cookies: { [ACCESS_COOKIE]: token } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'staff', userId: expect.any(String), tenantId: expect.any(String) });
  });

  it('rejects a refresh token used as an access token', async () => {
    const app = await buildWithProtectedRoutes();
    const res = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      cookies: { [ACCESS_COOKIE]: sign(app, 'refresh') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token signed with another secret', async () => {
    const other = await build({}, { JWT_SECRET: 'some-other-secret-0123456789' });
    const app = await buildWithProtectedRoutes();
    const res = await app.inject({
      method: 'GET',
      url: '/test/whoami',
      cookies: { [ACCESS_COOKIE]: sign(other, 'access') },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired access token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const app = await buildWithProtectedRoutes();
    const token = sign(app, 'access');
    vi.setSystemTime(Date.now() + 901_000);
    const res = await app.inject({ method: 'GET', url: '/test/whoami', cookies: { [ACCESS_COOKIE]: token } });
    expect(res.statusCode).toBe(401);
  });

  it('requireRole: 403 for staff, 200 for owner', async () => {
    const app = await buildWithProtectedRoutes();
    const staff = await app.inject({
      method: 'GET',
      url: '/test/owner-only',
      cookies: { [ACCESS_COOKIE]: sign(app, 'access', 'staff') },
    });
    expect(staff.statusCode).toBe(403);
    expect(staff.json()).toMatchObject({ error: 'forbidden' });
    const owner = await app.inject({
      method: 'GET',
      url: '/test/owner-only',
      cookies: { [ACCESS_COOKIE]: sign(app, 'access', 'owner') },
    });
    expect(owner.statusCode).toBe(200);
  });

  it('logout clears both cookies on the paths they were set with', async () => {
    const app = await build();
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(204);
    expect(cookie(res, ACCESS_COOKIE)).toMatchObject({ value: '', path: '/' });
    expect(cookie(res, REFRESH_COOKIE)).toMatchObject({ value: '', path: '/auth' });
  });

  it('rejects HTML-form bodies (CSRF protection relies on JSON-only)', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a%40b.c&password=x',
    });
    expect(res.statusCode).toBe(415);
  });
});

// Needs the docker-compose Postgres with migrations applied; skipped (not failed) when it's down.
const db = await connectTestDb();

describe.skipIf(!db)('auth routes (Postgres)', () => {
  const sql = db as Sql;
  const tenantIds: string[] = [];
  let app: FastifyInstance;

  const uniqueEmail = () => `test-${randomUUID()}@example.test`;
  const signup = async (email = uniqueEmail(), password = 'correct horse battery') => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { businessName: "Tony's Pizza (test)", timezone: 'america/chicago', email, password },
    });
    if (res.statusCode === 201) tenantIds.push(res.json().tenantId);
    return res;
  };

  beforeAll(async () => {
    app = await build({ sql });
  });

  afterAll(async () => {
    // ON DELETE CASCADE removes users + tenant_settings too.
    if (tenantIds.length) await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it('signup creates tenant, settings and owner, and sets secure cookies', async () => {
    const email = uniqueEmail();
    const res = await signup(email.toUpperCase());
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      userId: expect.any(String),
      tenantId: expect.any(String),
      role: 'owner',
      cardSetup: {
        setupIntentId: expect.any(String),
        clientSecret: expect.any(String),
        publishableKey: 'pk_test_fake',
        stripeJsUrl: 'https://stripe.test/v3/',
      },
    });

    const access = cookie(res, ACCESS_COOKIE);
    const refresh = cookie(res, REFRESH_COOKIE);
    expect(access).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 900 });
    expect(refresh).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/auth' });

    const [user] = await sql`select email, role, password_hash from users where id = ${body.userId}`;
    expect(user).toMatchObject({ email, role: 'owner' }); // stored lowercased
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    const [settings] = await sql`
      select record_calls, included_extensions, included_us_minutes from tenant_settings where tenant_id = ${body.tenantId}`;
    expect(settings).toEqual({ recordCalls: false, includedExtensions: 2, includedUsMinutes: 100 }); // the plan
    const [tenant] = await sql`select timezone, status from tenants where id = ${body.tenantId}`;
    expect(tenant).toEqual({ timezone: 'America/Chicago', status: 'active' }); // canonical spelling
  });

  it('signup requires a time zone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { businessName: 'No TZ', email: uniqueEmail(), password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^timezone: Required/);
  });

  it('GET /me returns the user and the business; 401 without a session or once deleted', async () => {
    const email = uniqueEmail();
    const signed = await signup(email);
    const { userId, tenantId } = signed.json();
    const access = cookie(signed, ACCESS_COOKIE)!.value;

    const me = await app.inject({ method: 'GET', url: '/me', cookies: { [ACCESS_COOKIE]: access } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      user: { id: userId, email, role: 'owner', createdAt: expect.any(String) },
      tenant: {
        id: tenantId,
        name: "Tony's Pizza (test)",
        timezone: 'America/Chicago',
        status: 'active',
        createdAt: expect.any(String),
      },
    });

    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    await sql`delete from users where id = ${userId}`;
    const gone = await app.inject({ method: 'GET', url: '/me', cookies: { [ACCESS_COOKIE]: access } });
    expect(gone.statusCode).toBe(401);
  });

  it('signup with an existing email (any case) is 409 and creates nothing', async () => {
    const email = uniqueEmail();
    expect((await signup(email)).statusCode).toBe(201);
    const [{ count: before }] = (await sql`select count(*)::int as count from tenants`) as unknown as [{ count: number }];
    const dup = await signup(email.toUpperCase());
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: 'email_taken' });
    const [{ count: after }] = (await sql`select count(*)::int as count from tenants`) as unknown as [{ count: number }];
    expect(after).toBe(before); // transaction rolled back the tenant insert
  });

  it('signup validates the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { businessName: '', timezone: 'Mars/Olympus_Mons', email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const { error, message } = res.json();
    expect(error).toBe('invalid_request');
    expect(message).toMatch(/businessName/);
    expect(message).toMatch(/timezone: must be an IANA time zone/);
    expect(message).toMatch(/email/);
    expect(message).toMatch(/password/);
  });

  it('login: right password 200, wrong password and unknown email the same 401', async () => {
    const email = uniqueEmail();
    const { userId } = (await signup(email, 'right password 1')).json();

    const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'right password 1' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ userId, role: 'owner' });
    expect(cookie(ok, ACCESS_COOKIE)?.value).toBeTruthy();

    const wrong = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong password' } });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: uniqueEmail(), password: 'right password 1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("users with an unusable hash (seed data's '!') can't log in", async () => {
    const { tenantId } = (await signup()).json();
    const email = uniqueEmail();
    await sql`insert into users (tenant_id, email, password_hash, role) values (${tenantId}, ${email}, '!', 'staff')`;
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: '!' } });
    expect(res.statusCode).toBe(401);
  });

  it('the access cookie from login works on a protected route', async () => {
    const protectedApp = await buildWithProtectedRoutes({ sql });
    const email = uniqueEmail();
    const { userId, tenantId } = (await signup(email, 'right password 1')).json();
    const login = await protectedApp.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'right password 1' },
    });
    const res = await protectedApp.inject({
      method: 'GET',
      url: '/test/whoami',
      cookies: { [ACCESS_COOKIE]: cookie(login, ACCESS_COOKIE)!.value },
    });
    expect(res.json()).toEqual({ userId, tenantId, role: 'owner' });
  });

  it('refresh: refresh cookie -> new cookies; access cookie is not accepted', async () => {
    const res = await signup();
    const refreshToken = cookie(res, REFRESH_COOKIE)!.value;
    const accessToken = cookie(res, ACCESS_COOKIE)!.value;

    const ok = await app.inject({ method: 'POST', url: '/auth/refresh', cookies: { [REFRESH_COOKIE]: refreshToken } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ userId: res.json().userId });
    expect(cookie(ok, ACCESS_COOKIE)?.value).toBeTruthy();
    expect(cookie(ok, REFRESH_COOKIE)?.value).toBeTruthy();

    const wrongType = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { [REFRESH_COOKIE]: accessToken },
    });
    expect(wrongType.statusCode).toBe(401);
  });

  it('refresh fails and clears cookies once the user is deleted', async () => {
    const res = await signup();
    await sql`delete from users where id = ${res.json().userId}`;
    const after = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      cookies: { [REFRESH_COOKIE]: cookie(res, REFRESH_COOKIE)!.value },
    });
    expect(after.statusCode).toBe(401);
    expect(cookie(after, ACCESS_COOKIE)?.value).toBe('');
    expect(cookie(after, REFRESH_COOKIE)?.value).toBe('');
  });
});
