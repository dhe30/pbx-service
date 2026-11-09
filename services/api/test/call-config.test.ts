import { randomUUID } from 'node:crypto';
import { parseIvrConfig, type Sql } from '@pbx/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { assertOwned } from '../src/tenancy.js';
import { build, connectTestDb } from './helpers.js';

// Step 5: mailboxes, ring groups, IVR menus, number routing.

describe('call configuration routes without a DB', () => {
  it('require login and the owner role', async () => {
    const app = await build();
    const staff = app.jwt.sign({ sub: randomUUID(), tid: randomUUID(), role: 'staff', typ: 'access' });
    const routes = [
      ['GET', '/mailboxes'],
      ['POST', '/mailboxes'],
      ['PUT', `/mailboxes/${randomUUID()}`],
      ['DELETE', `/mailboxes/${randomUUID()}`],
      ['GET', '/ring-groups'],
      ['POST', '/ring-groups'],
      ['GET', `/ring-groups/${randomUUID()}`],
      ['DELETE', `/ring-groups/${randomUUID()}`],
      ['GET', '/ivr-menus'],
      ['POST', '/ivr-menus'],
      ['PUT', `/ivr-menus/${randomUUID()}`],
      ['DELETE', `/ivr-menus/${randomUUID()}`],
      ['PUT', `/numbers/${randomUUID()}/route`],
      ['GET', '/business-hours'],
      ['POST', '/business-hours'],
      ['PUT', `/business-hours/${randomUUID()}`],
      ['DELETE', `/business-hours/${randomUUID()}`],
      ['GET', '/blocked-numbers'],
      ['POST', '/blocked-numbers'],
      ['DELETE', '/blocked-numbers/%2B12015550123'],
    ] as const;
    for (const [method, url] of routes) {
      const anon = await app.inject({ method, url, payload: {} });
      expect(anon.statusCode, `${method} ${url} anonymous`).toBe(401);
      const res = await app.inject({ method, url, payload: {}, cookies: { [ACCESS_COOKIE]: staff } });
      expect(res.statusCode, `${method} ${url} as staff`).toBe(403);
    }
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('call configuration (Postgres)', () => {
  const sql = db as Sql;
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  interface Tenant {
    tenantId: string;
    ownerId: string;
    staffId: string;
    staff2Id: string;
    ext1Id: string;
    ext2Id: string;
    greetingId: string;
    recordingId: string;
    numberId: string;
    cookies: Record<string, string>;
  }
  let a: Tenant;
  let b: Tenant;

  async function makeTenant(): Promise<Tenant> {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('Config test') returning id`;
    const tenantId = t!.id;
    tenantIds.push(tenantId);
    const user = async (role: 'owner' | 'staff') => {
      const [u] = await sql<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, role)
        values (${tenantId}, ${`${role}-${randomUUID()}@example.test`}, '!', ${role}) returning id`;
      return u!.id;
    };
    // Extensions are what rings (members, IVR "extension" targets). Rows only: no SIP account needed here.
    let extNo = 100;
    const extension = async () => {
      const [e] = await sql<{ id: string }[]>`
        insert into extensions (tenant_id, number, name, sip_username)
        values (${tenantId}, ${String(++extNo)}, 'Ext', ${`t${randomUUID().replaceAll('-', '')}`}) returning id`;
      return e!.id;
    };
    const media = async (kind: 'greeting' | 'recording') => {
      const [m] = await sql<{ id: string }[]>`
        insert into media (tenant_id, kind, object_key, format)
        values (${tenantId}, ${kind}, ${`test/${randomUUID()}.wav`}, 'wav') returning id`;
      return m!.id;
    };
    const ownerId = await user('owner');
    const did = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    const [n] = await sql<{ id: string }[]>`
      insert into phone_numbers (did, tenant_id, provider_ref) values (${did}, ${tenantId}, 'test') returning id`;
    return {
      tenantId,
      ownerId,
      staffId: await user('staff'),
      staff2Id: await user('staff'),
      ext1Id: await extension(),
      ext2Id: await extension(),
      greetingId: await media('greeting'),
      recordingId: await media('recording'),
      numberId: n!.id,
      cookies: {
        [ACCESS_COOKIE]: app.jwt.sign({ sub: ownerId, tid: tenantId, role: 'owner', typ: 'access' }),
      },
    };
  }

  const call = (t: Tenant, method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: t.cookies });

  async function mailbox(t: Tenant, body: object = { name: 'Main' }): Promise<string> {
    const res = await call(t, 'POST', '/mailboxes', body);
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  beforeAll(async () => {
    app = await build({ sql });
    a = await makeTenant();
    b = await makeTenant();
  });

  afterAll(async () => {
    await sql`delete from phone_numbers where tenant_id = any(${tenantIds}::uuid[])`;
    await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  describe('mailboxes', () => {
    it('create, read, list, replace', async () => {
      const created = await call(a, 'POST', '/mailboxes', {
        name: '  Sales ',
        greetingMediaId: a.greetingId,
        ownerUserId: a.staffId,
      });
      expect(created.statusCode).toBe(201);
      const mb = created.json();
      expect(mb).toEqual({ id: mb.id, name: 'Sales', greetingMediaId: a.greetingId, ownerUserId: a.staffId });

      expect((await call(a, 'GET', `/mailboxes/${mb.id}`)).json()).toEqual(mb);
      expect((await call(a, 'GET', '/mailboxes')).json()).toContainEqual(mb);

      // PUT is a full replace: omitted optional fields become null.
      const put = await call(a, 'PUT', `/mailboxes/${mb.id}`, { name: 'Sales 2' });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ id: mb.id, name: 'Sales 2', greetingMediaId: null, ownerUserId: null });
    });

    it("another tenant's mailbox is 404 on every route", async () => {
      const bMailbox = await mailbox(b);
      for (const [method, payload] of [['GET'], ['PUT', { name: 'x' }], ['DELETE']] as const) {
        const res = await call(a, method, `/mailboxes/${bMailbox}`, payload);
        expect(res.statusCode, method).toBe(404);
      }
      expect((await call(a, 'GET', '/mailboxes')).json().map((m: { id: string }) => m.id)).not.toContain(bMailbox);
    });

    it("rejects another tenant's owner, a non-greeting media file, and bad input", async () => {
      const cases: [object, string][] = [
        [{ name: 'X', ownerUserId: b.staffId }, 'ownerUserId: no such user'],
        [{ name: 'X', greetingMediaId: b.greetingId }, 'greetingMediaId: no such greeting'],
        [{ name: 'X', greetingMediaId: a.recordingId }, 'greetingMediaId: no such greeting'],
      ];
      for (const [body, message] of cases) {
        const res = await call(a, 'POST', '/mailboxes', body);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_reference', message });
      }
      const bad = await call(a, 'POST', '/mailboxes', { name: '', ownerUserId: 'nope' });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toMatch(/name: .*ownerUserId: /);
    });

    it('delete: 409 while an IVR menu or ring group uses it, then 204', async () => {
      const mb = await mailbox(a, { name: 'Busy' });
      const rg = await call(a, 'POST', '/ring-groups', {
        name: 'Uses mailbox',
        noAnswerDestination: { type: 'voicemail', id: mb },
      });
      const ivr = await call(a, 'POST', '/ivr-menus', {
        name: 'Uses mailbox',
        config: { options: {}, timeout: { type: 'voicemail', id: mb } },
      });

      const refused = await call(a, 'DELETE', `/mailboxes/${mb}`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({
        error: 'in_use',
        message: 'Used by IVR menu "Uses mailbox", ring group "Uses mailbox"; change those first',
      });

      await call(a, 'DELETE', `/ivr-menus/${ivr.json().id}`);
      await call(a, 'DELETE', `/ring-groups/${rg.json().id}`);
      expect((await call(a, 'DELETE', `/mailboxes/${mb}`)).statusCode).toBe(204);
      expect((await call(a, 'GET', `/mailboxes/${mb}`)).statusCode).toBe(404);
    });
  });

  describe('ring groups', () => {
    it('create with ordered members and defaults; PUT replaces members', async () => {
      const mb = await mailbox(a);
      const res = await call(a, 'POST', '/ring-groups', {
        name: 'Kitchen',
        strategy: 'sequential',
        noAnswerDestination: { type: 'voicemail', id: mb },
        memberIds: [a.ext2Id, a.ext1Id],
      });
      expect(res.statusCode).toBe(201);
      const rg = res.json();
      expect(rg).toEqual({
        id: rg.id,
        name: 'Kitchen',
        strategy: 'sequential',
        ringTimeoutSec: 20,
        noAnswerDestination: { type: 'voicemail', id: mb },
        memberIds: [a.ext2Id, a.ext1Id],
      });
      expect((await call(a, 'GET', `/ring-groups/${rg.id}`)).json()).toEqual(rg);

      const put = await call(a, 'PUT', `/ring-groups/${rg.id}`, { name: 'Kitchen', memberIds: [a.ext1Id] });
      expect(put.json()).toMatchObject({ strategy: 'all', noAnswerDestination: null, memberIds: [a.ext1Id] });
      const rows = await sql`select extension_id, position from ring_group_members where ring_group_id = ${rg.id}`;
      expect(rows).toEqual([{ extensionId: a.ext1Id, position: 0 }]);

      const empty = await call(a, 'PUT', `/ring-groups/${rg.id}`, { name: 'Empty' });
      expect(empty.json().memberIds).toEqual([]);
    });

    it("rejects other tenants' members and destinations, non-extension members, duplicates, bad bounds", async () => {
      const cases: [object, string][] = [
        [{ name: 'X', memberIds: [a.ext1Id, b.ext1Id] }, 'memberIds.1: no such extension'],
        [{ name: 'X', memberIds: [a.staffId] }, 'memberIds.0: no such extension'],
        [{ name: 'X', noAnswerDestination: { type: 'voicemail', id: await mailbox(b) } }, 'noAnswerDestination.id: no such mailbox'],
      ];
      for (const [body, message] of cases) {
        const res = await call(a, 'POST', '/ring-groups', body);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_reference', message });
      }
      const dup = await call(a, 'POST', '/ring-groups', { name: 'X', memberIds: [a.ext1Id, a.ext1Id] });
      expect(dup.json()).toEqual({ error: 'invalid_request', message: 'memberIds: must not contain duplicates' });
      const timeout = await call(a, 'POST', '/ring-groups', { name: 'X', ringTimeoutSec: 4, strategy: 'random' });
      expect(timeout.json().message).toMatch(/strategy: .*ringTimeoutSec: /);
    });

    it("another tenant's ring group is 404, and is never listed", async () => {
      const bGroup = (await call(b, 'POST', '/ring-groups', { name: 'B only' })).json().id;
      expect((await call(a, 'GET', `/ring-groups/${bGroup}`)).statusCode).toBe(404);
      expect((await call(a, 'PUT', `/ring-groups/${bGroup}`, { name: 'x' })).statusCode).toBe(404);
      expect((await call(a, 'DELETE', `/ring-groups/${bGroup}`)).statusCode).toBe(404);
      const list = (await call(a, 'GET', '/ring-groups')).json() as { id: string }[];
      expect(list.map((g) => g.id)).not.toContain(bGroup);
    });

    it('delete: 409 while an IVR menu routes to it', async () => {
      const rg = (await call(a, 'POST', '/ring-groups', { name: 'Routed' })).json().id;
      await call(a, 'POST', '/ivr-menus', {
        name: 'Front desk',
        config: { options: { '1': { type: 'ring_group', id: rg } } },
      });
      const res = await call(a, 'DELETE', `/ring-groups/${rg}`);
      expect(res.json()).toEqual({ error: 'in_use', message: 'Used by IVR menu "Front desk"; change that first' });
    });
  });

  describe('IVR menus', () => {
    it('create, read back and re-save; snake_case config keys (repeat_digit) survive throughout', async () => {
      const mb = await mailbox(a);
      const rg = (await call(a, 'POST', '/ring-groups', { name: 'All', memberIds: [a.ext1Id] })).json().id;
      const config = {
        options: {
          '1': { type: 'ring_group', id: rg },
          '2': { type: 'voicemail', id: mb },
          '0': { type: 'extension', id: a.ext1Id },
          '9': { type: 'external', number: '+12015550123' },
        },
        timeout: { type: 'voicemail', id: mb },
        invalid: { type: 'hangup' },
        repeat_digit: '*',
      };
      const res = await call(a, 'POST', '/ivr-menus', { name: 'Main', greetingMediaId: a.greetingId, config });
      expect(res.statusCode).toBe(201);
      const menu = res.json();
      expect(menu).toEqual({ id: menu.id, name: 'Main', greetingMediaId: a.greetingId, timeoutSec: 5, maxRetries: 3, config });
      expect((await call(a, 'GET', `/ivr-menus/${menu.id}`)).json()).toEqual(menu);

      // Read it the way the ARI app does (shared createDb + parseIvrConfig): JSON keys must come
      // back as stored, not camelCased (repeat_digit, not repeatDigit).
      const [row] = await sql`select config from ivr_menus where id = ${menu.id}`;
      expect(parseIvrConfig(row!.config)).toEqual(config);

      // A dashboard edit sends back what GET returned; everything must survive the round trip.
      const again = await call(a, 'PUT', `/ivr-menus/${menu.id}`, menu);
      expect(again.json().config).toEqual(config);
    });

    it('accepts the phase-1 format ({action, target}, on_timeout) and stores the new one', async () => {
      const mb = await mailbox(a);
      const res = await call(a, 'POST', '/ivr-menus', {
        name: 'Legacy',
        config: { options: { '2': { action: 'voicemail', target: mb } }, on_timeout: { action: 'voicemail', target: mb } },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().config).toEqual({
        options: { '2': { type: 'voicemail', id: mb } },
        timeout: { type: 'voicemail', id: mb },
      });
    });

    it('rejects phase-1 {action:"user"} targets instead of silently storing "hang up"', async () => {
      const res = await call(a, 'POST', '/ivr-menus', {
        name: 'Legacy user',
        config: { options: { '4': { action: 'user', target: a.staffId } } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/^config\.options\.4: phase-1 \{"action":"user"\} is no longer supported/);
    });

    it('rejects bad configs and references, naming the field', async () => {
      const bGroup = (await call(b, 'POST', '/ring-groups', { name: 'B' })).json().id;
      const cases: [object, number, string][] = [
        [{ options: { '3': { type: 'ring_group', id: bGroup } } }, 400, 'config.options.3.id: no such ring group'],
        [{ options: { '0': { type: 'extension', id: b.ext1Id } } }, 400, 'config.options.0.id: no such extension'],
        [{ options: {}, timeout: { type: 'voicemail', id: randomUUID() } }, 400, 'config.timeout.id: no such mailbox'],
        [{ options: {}, invalid: { type: 'ivr_menu', id: randomUUID() } }, 400, 'config.invalid.id: no such IVR menu'],
      ];
      for (const [config, status, message] of cases) {
        const res = await call(a, 'POST', '/ivr-menus', { name: 'Bad', config });
        expect(res.statusCode).toBe(status);
        expect(res.json()).toEqual({ error: 'invalid_reference', message });
      }
      const shape = await call(a, 'POST', '/ivr-menus', {
        name: 'Bad',
        timeoutSec: 0,
        config: { options: { '12': { action: 'dial', target: 'x' } } },
      });
      expect(shape.statusCode).toBe(400);
      expect(shape.json().error).toBe('invalid_request');
      const greeting = await call(a, 'POST', '/ivr-menus', { name: 'Bad', greetingMediaId: a.recordingId });
      expect(greeting.json().message).toBe('greetingMediaId: no such greeting');
    });

    it('PUT replaces; another tenant gets 404', async () => {
      const menu = (await call(a, 'POST', '/ivr-menus', { name: 'Old', timeoutSec: 9 })).json();
      const put = await call(a, 'PUT', `/ivr-menus/${menu.id}`, { name: 'New' });
      expect(put.json()).toEqual({ id: menu.id, name: 'New', greetingMediaId: null, timeoutSec: 5, maxRetries: 3, config: { options: {} } });
      expect((await call(b, 'GET', `/ivr-menus/${menu.id}`)).statusCode).toBe(404);
      expect((await call(b, 'PUT', `/ivr-menus/${menu.id}`, { name: 'Hijack' })).statusCode).toBe(404);
      expect((await call(b, 'DELETE', `/ivr-menus/${menu.id}`)).statusCode).toBe(404);
    });
  });

  describe('number routing', () => {
    it('routes a number to a menu; 409 deleting that menu; null unroutes', async () => {
      const menu = (await call(a, 'POST', '/ivr-menus', { name: 'Routed menu' })).json().id;
      const res = await call(a, 'PUT', `/numbers/${a.numberId}/route`, { destination: { type: 'ivr_menu', id: menu } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: a.numberId, status: 'assigned', destination: { type: 'ivr_menu', id: menu } });

      const [did] = await sql<{ did: string }[]>`select did from phone_numbers where id = ${a.numberId}`;
      const del = await call(a, 'DELETE', `/ivr-menus/${menu}`);
      expect(del.json()).toEqual({ error: 'in_use', message: `Used by phone number "${did!.did}"; change that first` });

      const off = await call(a, 'PUT', `/numbers/${a.numberId}/route`, {});
      expect(off.json().destination).toBeNull();
      expect((await call(a, 'DELETE', `/ivr-menus/${menu}`)).statusCode).toBe(204);
    });

    it('routes to an extension or a ring group too; the phase-1 body { ivrMenuId } still works', async () => {
      const ext = await call(a, 'PUT', `/numbers/${a.numberId}/route`, { destination: { type: 'extension', id: a.ext1Id } });
      expect(ext.json().destination).toEqual({ type: 'extension', id: a.ext1Id });
      const menu = (await call(a, 'POST', '/ivr-menus', { name: 'Legacy route' })).json().id;
      const legacy = await call(a, 'PUT', `/numbers/${a.numberId}/route`, { ivrMenuId: menu });
      expect(legacy.json().destination).toEqual({ type: 'ivr_menu', id: menu });
      const bad = await call(a, 'PUT', `/numbers/${a.numberId}/route`, { destination: { type: 'nope' } });
      expect(bad.statusCode).toBe(400); // never silently unrouted
      await call(a, 'PUT', `/numbers/${a.numberId}/route`, {});
    });

    it("another tenant's menu is 400; another tenant's or a released number is 404", async () => {
      const bMenu = (await call(b, 'POST', '/ivr-menus', { name: 'B menu' })).json().id;
      const foreignMenu = await call(a, 'PUT', `/numbers/${a.numberId}/route`, { ivrMenuId: bMenu });
      expect(foreignMenu.json()).toEqual({ error: 'invalid_reference', message: 'destination.id: no such IVR menu' });

      expect((await call(a, 'PUT', `/numbers/${b.numberId}/route`, {})).statusCode).toBe(404);
      const released = await makeTenant();
      await sql`update phone_numbers set status = 'released' where id = ${released.numberId}`;
      expect((await call(released, 'PUT', `/numbers/${released.numberId}/route`, {})).statusCode).toBe(404);
    });
  });

  describe('business hours', () => {
    const weekdays = { intervals: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })) };

    it('create, read, replace; openNow follows the account time zone', async () => {
      const mb = await mailbox(a);
      const body = {
        name: 'Office',
        schedule: weekdays,
        openDestination: { type: 'extension', id: a.ext1Id },
        closedDestination: { type: 'voicemail', id: mb },
      };
      const res = await call(a, 'POST', '/business-hours', body);
      expect(res.statusCode).toBe(201);
      const hours = res.json();
      expect(hours).toEqual({ id: expect.any(String), ...body, openNow: expect.any(Boolean) });
      expect((await call(a, 'GET', `/business-hours/${hours.id}`)).json()).toEqual(hours);
      expect((await call(a, 'GET', '/business-hours')).json().map((h: { id: string }) => h.id)).toContain(hours.id);

      // Always open / never open, independent of the test's clock.
      const always = { intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })) };
      const put = await call(a, 'PUT', `/business-hours/${hours.id}`, { ...hours, schedule: always });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ schedule: always, openNow: true });
      const never = await call(a, 'PUT', `/business-hours/${hours.id}`, { ...hours, schedule: { intervals: [] } });
      expect(never.json().openNow).toBe(false);

      // Stored the way the ARI app reads it (snake_case columns, JSON as given).
      const [row] = await sql`select schedule, open_destination from business_hours where id = ${hours.id}`;
      expect(row).toEqual({ schedule: { intervals: [] }, openDestination: { type: 'extension', id: a.ext1Id } });
    });

    it('validates schedule and destinations; other tenants get 404', async () => {
      const ok = { name: 'X', schedule: weekdays, openDestination: { type: 'hangup' }, closedDestination: { type: 'hangup' } };
      const bad = await call(a, 'POST', '/business-hours', { ...ok, schedule: { intervals: [{ day: 7, start: '9:00', end: '17:00' }] } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().message).toMatch(/schedule\.intervals\.0\.day/);
      expect(bad.json().message).toMatch(/schedule\.intervals\.0\.start: HH:MM/);
      const missing = await call(a, 'POST', '/business-hours', { name: 'X', schedule: weekdays });
      expect(missing.json().message).toMatch(/openDestination: Required/);
      const foreign = await call(a, 'POST', '/business-hours', { ...ok, closedDestination: { type: 'extension', id: b.ext1Id } });
      expect(foreign.json()).toEqual({ error: 'invalid_reference', message: 'closedDestination.id: no such extension' });

      const id = (await call(a, 'POST', '/business-hours', ok)).json().id;
      expect((await call(b, 'GET', `/business-hours/${id}`)).statusCode).toBe(404);
      expect((await call(b, 'PUT', `/business-hours/${id}`, ok)).statusCode).toBe(404);
      expect((await call(b, 'DELETE', `/business-hours/${id}`)).statusCode).toBe(404);
      expect((await call(b, 'GET', '/business-hours')).json()).toEqual([]);
    });

    it('a number can route to it; deleting it is refused while used, deleting its targets too', async () => {
      const mb = await mailbox(a, { name: 'After hours' });
      const hours = (
        await call(a, 'POST', '/business-hours', {
          name: 'Routed hours',
          schedule: weekdays,
          openDestination: { type: 'hangup' },
          closedDestination: { type: 'voicemail', id: mb },
        })
      ).json();
      const route = await call(a, 'PUT', `/numbers/${a.numberId}/route`, { destination: { type: 'business_hours', id: hours.id } });
      expect(route.statusCode).toBe(200);

      const del = await call(a, 'DELETE', `/business-hours/${hours.id}`);
      expect(del.statusCode).toBe(409);
      expect(del.json().message).toMatch(/^Used by phone number "\+1555/);
      const delMailbox = await call(a, 'DELETE', `/mailboxes/${mb}`);
      expect(delMailbox.json()).toEqual({ error: 'in_use', message: 'Used by business hours "Routed hours"; change that first' });

      await call(a, 'PUT', `/numbers/${a.numberId}/route`, { destination: null });
      expect((await call(a, 'DELETE', `/business-hours/${hours.id}`)).statusCode).toBe(204);
      expect((await call(a, 'GET', `/business-hours/${hours.id}`)).statusCode).toBe(404);
    });
  });

  describe('blocked numbers', () => {
    it('normalizes, is idempotent, lists newest first, unblocks; tenants are separate', async () => {
      const first = await call(a, 'POST', '/blocked-numbers', { number: '(201) 555-0100' });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toEqual({ number: '+12015550100', createdAt: expect.any(String) });
      const again = await call(a, 'POST', '/blocked-numbers', { number: '+12015550100' });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual(first.json());
      expect((await call(a, 'POST', '/blocked-numbers', { number: '011 44 20 7946 0000' })).json().number).toBe('+442079460000');

      const list = (await call(a, 'GET', '/blocked-numbers')).json();
      expect(list.map((r: { number: string }) => r.number)).toEqual(['+442079460000', '+12015550100']);
      expect((await call(b, 'GET', '/blocked-numbers')).json()).toEqual([]);
      expect((await call(b, 'DELETE', '/blocked-numbers/%2B12015550100')).statusCode).toBe(404);

      expect((await call(a, 'DELETE', '/blocked-numbers/%2B12015550100')).statusCode).toBe(204);
      expect((await call(a, 'DELETE', '/blocked-numbers/2015550100')).statusCode).toBe(404);
      expect((await call(a, 'DELETE', '/blocked-numbers/12015550100')).statusCode).toBe(404);
      expect((await call(a, 'DELETE', '/blocked-numbers/442079460000')).statusCode).toBe(400); // not a dialable format
      expect((await call(a, 'DELETE', '/blocked-numbers/%2B442079460000')).statusCode).toBe(204);
    });

    it('rejects things that are not phone numbers', async () => {
      for (const number of ['101', 'abc', '+0123', '']) {
        const res = await call(a, 'POST', '/blocked-numbers', { number });
        expect(res.statusCode, number).toBe(400);
        expect(res.json().message).toMatch(/^number: must be a phone number/);
      }
    });
  });

  it('a save in progress makes a concurrent delete wait, then refuse (no dangling reference)', async () => {
    const mb = await mailbox(a, { name: 'Raced' });
    const rg = (await call(a, 'POST', '/ring-groups', { name: 'Racer' })).json().id;

    let deleteDone = false;
    let pendingDelete: Promise<{ statusCode: number }> | undefined;
    await sql.begin(async (tx) => {
      // What PUT /ring-groups/:id does: check + lock the mailbox, then store the reference.
      await assertOwned(tx, a.tenantId, [{ table: 'mailboxes', id: mb, field: 'noAnswerDestination.id' }]);
      pendingDelete = call(a, 'DELETE', `/mailboxes/${mb}`).then((r) => {
        deleteDone = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(deleteDone).toBe(false); // blocked on the FOR SHARE lock
      await tx`update ring_groups set no_answer_destination = ${tx.json({ type: 'voicemail', id: mb })} where id = ${rg}`;
    });
    const res = await pendingDelete!;
    expect(res.statusCode).toBe(409);
  });
});
