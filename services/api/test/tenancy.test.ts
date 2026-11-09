import { randomUUID } from 'node:crypto';
import type { Sql } from '@pbx/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE, authenticate } from '../src/auth.js';
import { HttpError } from '../src/errors.js';
import { IdParams, assertOwned, ivrConfigRefs, requireOwned, tenantOf } from '../src/tenancy.js';
import { parse } from '../src/validation.js';
import { build, connectTestDb } from './helpers.js';

describe('tenantOf / ivrConfigRefs (no DB)', () => {
  it('tenantOf without authenticate is a 500 (route bug), never data', async () => {
    const app = await build();
    app.get('/test/forgot-auth', async (req) => ({ tenantId: tenantOf(req) }));
    const res = await app.inject({ method: 'GET', url: '/test/forgot-auth' });
    expect(res.statusCode).toBe(500);
  });

  it('tenantOf returns the tenant from the token, ignoring URL and body', async () => {
    const app = await build();
    app.post('/test/tenants/:tenantId/echo', { preHandler: authenticate }, async (req) => ({ tenantId: tenantOf(req) }));
    const mine = randomUUID();
    const token = app.jwt.sign({ sub: randomUUID(), tid: mine, role: 'owner', typ: 'access' });
    const res = await app.inject({
      method: 'POST',
      url: `/test/tenants/${randomUUID()}/echo`,
      payload: { tenantId: randomUUID() },
      cookies: { [ACCESS_COOKIE]: token },
    });
    expect(res.json()).toEqual({ tenantId: mine });
  });

  it('ivrConfigRefs lists every destination id with its field path (external / hangup have none)', () => {
    const [rg, mb, ext, menu] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const refs = ivrConfigRefs({
      options: {
        '1': { type: 'ring_group', id: rg },
        '0': { type: 'extension', id: ext },
        '9': { type: 'external', number: '+12015550123' },
      },
      timeout: { type: 'voicemail', id: mb },
      invalid: { type: 'ivr_menu', id: menu },
    });
    expect(refs).toEqual(
      expect.arrayContaining([
        { table: 'ring_groups', id: rg, field: 'config.options.1.id' },
        { table: 'extensions', id: ext, field: 'config.options.0.id' },
        { table: 'mailboxes', id: mb, field: 'config.timeout.id' },
        { table: 'ivr_menus', id: menu, field: 'config.invalid.id' },
      ]),
    );
    expect(refs).toHaveLength(4);
  });

  it('IdParams rejects non-uuid ids with 400', async () => {
    const app = await build();
    app.get('/test/things/:id', async (req) => parse(IdParams, req.params));
    const res = await app.inject({ method: 'GET', url: '/test/things/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('tenant isolation (Postgres)', () => {
  const sql = db as Sql;
  interface Fixture {
    tenantId: string;
    userId: string;
    mailboxId: string;
    ringGroupId: string;
    ivrMenuId: string;
  }
  let a: Fixture;
  let b: Fixture;
  let app: FastifyInstance;

  async function makeTenant(name: string): Promise<Fixture> {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values (${name}) returning id`;
    const tenantId = t!.id;
    const [u] = await sql<{ id: string }[]>`
      insert into users (tenant_id, email, password_hash, role)
      values (${tenantId}, ${`test-${randomUUID()}@example.test`}, '!', 'owner') returning id`;
    const [m] = await sql<{ id: string }[]>`
      insert into mailboxes (tenant_id, name) values (${tenantId}, 'Main') returning id`;
    const [rg] = await sql<{ id: string }[]>`
      insert into ring_groups (tenant_id, name) values (${tenantId}, 'Everyone') returning id`;
    const [ivr] = await sql<{ id: string }[]>`
      insert into ivr_menus (tenant_id, name) values (${tenantId}, 'Main menu') returning id`;
    return { tenantId, userId: u!.id, mailboxId: m!.id, ringGroupId: rg!.id, ivrMenuId: ivr!.id };
  }

  const tokenFor = (f: Fixture) => app.jwt.sign({ sub: f.userId, tid: f.tenantId, role: 'owner', typ: 'access' });

  beforeAll(async () => {
    a = await makeTenant('Tenant A (test)');
    b = await makeTenant('Tenant B (test)');
    app = await build({ sql });

    // A route written the way step 5+ routes will be: scoped read, 404 for other tenants.
    app.get('/test/mailboxes/:id', { preHandler: authenticate }, async (req) => {
      const { id } = parse(IdParams, req.params);
      const [row] = await sql`select id, name from mailboxes where id = ${id} and tenant_id = ${tenantOf(req)}`;
      if (!row) throw new HttpError(404, 'not_found', 'No such mailbox');
      return row;
    });
    // A route that forgot to validate its id: Postgres rejects it, must still be a 400.
    app.get('/test/raw/:id', async (req) => {
      const { id } = req.params as { id: string };
      return sql`select 1 from mailboxes where id = ${id}`;
    });
  });

  afterAll(async () => {
    await sql`delete from tenants where id = any(${[a.tenantId, b.tenantId]}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  it("a scoped route returns your row and 404s another tenant's row", async () => {
    const own = await app.inject({
      method: 'GET',
      url: `/test/mailboxes/${a.mailboxId}`,
      cookies: { [ACCESS_COOKIE]: tokenFor(a) },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: a.mailboxId });

    const other = await app.inject({
      method: 'GET',
      url: `/test/mailboxes/${b.mailboxId}`,
      cookies: { [ACCESS_COOKIE]: tokenFor(a) },
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/test/mailboxes/${randomUUID()}`,
      cookies: { [ACCESS_COOKIE]: tokenFor(a) },
    });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual(missing.json()); // can't tell "someone else's" from "doesn't exist"
  });

  it('requireOwned: ok for own row, 404 for other tenant, unknown or malformed ids', async () => {
    await expect(requireOwned(sql, a.tenantId, 'ring_groups', a.ringGroupId)).resolves.toBeUndefined();
    for (const id of [b.ringGroupId, randomUUID(), 'not-a-uuid']) {
      await expect(requireOwned(sql, a.tenantId, 'ring_groups', id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'not_found',
        message: 'No such ring group',
      });
    }
  });

  it('assertOwned: passes for own refs (duplicates fine, empty list fine)', async () => {
    await expect(
      assertOwned(sql, a.tenantId, [
        { table: 'mailboxes', id: a.mailboxId, field: 'fallback_mailbox_id' },
        { table: 'users', id: a.userId, field: 'members.0' },
        { table: 'users', id: a.userId, field: 'members.1' },
      ]),
    ).resolves.toBeUndefined();
    await expect(assertOwned(sql, a.tenantId, [])).resolves.toBeUndefined();
  });

  it("assertOwned: 400 invalid_reference naming the field for another tenant's id", async () => {
    await expect(
      assertOwned(sql, a.tenantId, [
        { table: 'users', id: a.userId, field: 'members.0' },
        { table: 'users', id: b.userId, field: 'members.1' },
      ]),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_reference',
      message: 'members.1: no such user',
    });
  });

  it('assertOwned: same answer for unknown and malformed ids', async () => {
    for (const id of [randomUUID(), 'nope']) {
      await expect(
        assertOwned(sql, a.tenantId, [{ table: 'mailboxes', id, field: 'fallback_mailbox_id' }]),
      ).rejects.toMatchObject({ statusCode: 400, message: 'fallback_mailbox_id: no such mailbox' });
    }
  });

  it("assertOwned + ivrConfigRefs: an IVR config pointing at another tenant's ring group is rejected", async () => {
    const config = {
      options: {
        '1': { type: 'ring_group' as const, id: a.ringGroupId },
        '2': { type: 'ring_group' as const, id: b.ringGroupId },
      },
      timeout: { type: 'voicemail' as const, id: a.mailboxId },
    };
    await expect(assertOwned(sql, a.tenantId, ivrConfigRefs(config))).rejects.toMatchObject({
      message: 'config.options.2.id: no such ring group',
    });
  });

  it('assertOwned works inside a transaction (the intended use before a write)', async () => {
    await sql.begin(async (tx) => {
      await assertOwned(tx, a.tenantId, [{ table: 'mailboxes', id: a.mailboxId, field: 'fallback_mailbox_id' }]);
      await tx`update ring_groups set fallback_mailbox_id = ${a.mailboxId}
               where id = ${a.ringGroupId} and tenant_id = ${a.tenantId}`;
    });
    const [rg] = await sql`select fallback_mailbox_id from ring_groups where id = ${a.ringGroupId}`;
    expect(rg).toEqual({ fallbackMailboxId: a.mailboxId });
  });

  it('a malformed uuid reaching Postgres is a 400, not a 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/raw/xyz' });
    expect(res.statusCode).toBe(400);
  });
});
