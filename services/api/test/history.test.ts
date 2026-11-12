import { randomUUID } from 'node:crypto';
import { mediaObjectKey, type Sql } from '@pbx/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCESS_COOKIE } from '../src/auth.js';
import { MemoryStore, build, connectTestDb } from './helpers.js';

// Step 7: call history (/calls), voicemail inbox (/voicemails), settings.

describe('history routes without a DB', () => {
  it('require login', async () => {
    const app = await build();
    const id = randomUUID();
    for (const [method, url] of [
      ['GET', '/calls'],
      ['GET', `/calls/${id}`],
      ['GET', `/calls/${id}/recording`],
      ['GET', '/voicemails'],
      ['GET', `/voicemails/${id}`],
      ['PATCH', `/voicemails/${id}`],
      ['DELETE', `/voicemails/${id}`],
      ['GET', `/voicemails/${id}/audio`],
      ['GET', '/settings'],
    ] as const) {
      expect((await app.inject({ method, url })).statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

const db = await connectTestDb();

describe.skipIf(!db)('history (Postgres)', () => {
  const sql = db as Sql;
  const store = new MemoryStore();
  let app: FastifyInstance;
  const tenantIds: string[] = [];

  interface User {
    id: string;
    cookies: Record<string, string>;
  }
  interface Tenant {
    id: string;
    owner: User;
    staff: User; // has extension 101 and owns mailbox "Staff box"
    other: User; // staff without extensions or mailboxes
    boxes: { staff: string; ext: string; main: string };
  }
  let a: Tenant;
  let b: Tenant;

  async function makeTenant(): Promise<Tenant> {
    const [t] = await sql<{ id: string }[]>`insert into tenants (name) values ('History test') returning id`;
    const tenantId = t!.id;
    tenantIds.push(tenantId);
    const user = async (role: 'owner' | 'staff'): Promise<User> => {
      const [u] = await sql<{ id: string }[]>`
        insert into users (tenant_id, email, password_hash, role)
        values (${tenantId}, ${`${role}-${randomUUID()}@example.test`}, '!', ${role}) returning id`;
      return { id: u!.id, cookies: { [ACCESS_COOKIE]: app.jwt.sign({ sub: u!.id, tid: tenantId, role, typ: 'access' }) } };
    };
    const owner = await user('owner');
    const staff = await user('staff');
    const other = await user('staff');
    const box = async (name: string, ownerUserId: string | null) =>
      (await sql<{ id: string }[]>`
        insert into mailboxes (tenant_id, name, owner_user_id) values (${tenantId}, ${name}, ${ownerUserId}) returning id`)[0]!.id;
    const boxes = { staff: await box('Staff box', staff.id), ext: await box('Ext 101 box', null), main: await box('Main', null) };
    const ext = async (number: string, userId: string | null, mailboxId: string | null) =>
      sql`insert into extensions (tenant_id, number, name, sip_username, user_id, mailbox_id)
          values (${tenantId}, ${number}, 'Ext', ${`h${randomUUID().replaceAll('-', '')}`}, ${userId}, ${mailboxId})`;
    await ext('101', staff.id, boxes.ext);
    await ext('102', null, boxes.main);
    return { id: tenantId, owner, staff, other, boxes };
  }

  const call = (u: User, method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, payload, cookies: u.cookies });

  interface Leg {
    callId?: string;
    parentId?: string | null;
    direction: 'incoming' | 'outgoing' | 'internal';
    from?: string | null;
    to?: string | null;
    did?: string | null;
    fromExt?: string | null;
    toExt?: string | null;
    startedAt: string;
    outcome?: 'answered' | 'busy' | 'no_answer' | 'failed' | 'blocked';
    charge?: number;
    cost?: number;
    voicemail?: boolean;
  }
  async function cdr(t: Tenant, l: Leg): Promise<{ id: string; callId: string }> {
    const id = randomUUID();
    const callId = l.callId ?? randomUUID();
    await sql`
      insert into cdrs (id, call_id, parent_id, tenant_id, direction, from_number, to_number, did, from_extension,
                        to_extension, started_at, answered_at, ended_at, billable_sec, outcome, cost, charge, voicemail, pbx_node)
      values (${id}, ${callId}, ${l.parentId ?? null}, ${t.id}, ${l.direction}, ${l.from ?? null}, ${l.to ?? null},
              ${l.did ?? null}, ${l.fromExt ?? null}, ${l.toExt ?? null}, ${l.startedAt}::timestamptz,
              ${l.startedAt}::timestamptz + interval '1 second', ${l.startedAt}::timestamptz + interval '61 seconds',
              ${l.outcome === 'answered' || !l.outcome ? 60 : 0}, ${l.outcome ?? 'answered'}, ${l.cost ?? 0}, ${l.charge ?? 0},
              ${l.voicemail ?? false}, 'test')`;
    return { id, callId };
  }

  async function audio(t: Tenant, kind: 'recording' | 'voicemail', callId: string | null): Promise<{ mediaId: string; key: string }> {
    const mediaId = randomUUID();
    const key = mediaObjectKey(t.id, kind, mediaId);
    await store.put(key, Buffer.from(`RIFF-${kind}-${mediaId}`), 'audio/wav');
    await sql`insert into media (id, tenant_id, kind, object_key, format, duration_ms, call_id)
              values (${mediaId}, ${t.id}, ${kind}, ${key}, 'wav', 4200, ${callId})`;
    return { mediaId, key };
  }

  async function voicemail(t: Tenant, mailboxId: string, createdAt: string, heard = false) {
    const callId = randomUUID();
    const { mediaId, key } = await audio(t, 'voicemail', callId);
    const [v] = await sql<{ id: string }[]>`
      insert into voicemails (tenant_id, mailbox_id, call_id, media_id, caller_number, heard, created_at)
      values (${t.id}, ${mailboxId}, ${callId}, ${mediaId}, '+12015550123', ${heard}, ${createdAt}::timestamptz) returning id`;
    return { id: v!.id, mediaId, key, callId };
  }

  // Calls of tenant A, oldest to newest.
  let incoming: { id: string; callId: string }; // PSTN -> 101, recorded, with an extra forwarded leg
  let forwardLeg: { id: string; callId: string };
  let outgoing: { id: string; callId: string }; // 102 -> PSTN, intl
  let internal: { id: string; callId: string }; // 102 -> 101, busy
  let missed: { id: string; callId: string }; // PSTN -> 102, voicemail
  const tied: string[] = []; // 3 legs with the same started_at (paging tie-break by id)

  beforeAll(async () => {
    app = await build({ sql, store });
    a = await makeTenant();
    b = await makeTenant();
    incoming = await cdr(a, {
      direction: 'incoming', from: '+12015550123', to: '+15165550100', did: '+15165550100', toExt: '101',
      startedAt: '2026-11-01T10:00:00.000001Z',
    });
    forwardLeg = await cdr(a, {
      callId: incoming.callId, parentId: incoming.id, direction: 'outgoing', from: '+15165550100', to: '+19175550199',
      startedAt: '2026-11-01T10:00:05Z', charge: 0.06,
    });
    await audio(a, 'recording', incoming.callId);
    outgoing = await cdr(a, {
      direction: 'outgoing', from: '+15165550100', to: '+442071234567', did: '+15165550100', fromExt: '102',
      startedAt: '2026-11-02T09:30:00Z', cost: 0.020576, charge: 0.123456,
    });
    internal = await cdr(a, { direction: 'internal', from: '102', to: '101', fromExt: '102', toExt: '101', startedAt: '2026-11-03T12:00:00Z', outcome: 'busy' });
    missed = await cdr(a, {
      direction: 'incoming', from: '+13125550111', to: '+15165550100', did: '+15165550100', toExt: '102',
      startedAt: '2026-11-04T08:00:00Z', outcome: 'no_answer', voicemail: true,
    });
    for (let i = 0; i < 3; i++) {
      tied.push((await cdr(a, { direction: 'internal', from: '101', to: '102', fromExt: '101', toExt: '102', startedAt: '2026-11-05T00:00:00.123456Z' })).id);
    }
    await cdr(b, { direction: 'incoming', from: '+12015550123', to: '+15165550999', startedAt: '2026-11-04T00:00:00Z' });
  });

  afterAll(async () => {
    await sql`delete from cdrs where tenant_id = any(${tenantIds}::uuid[])`;
    await sql`delete from tenants where id = any(${tenantIds}::uuid[])`;
    await sql.end({ timeout: 2 });
  });

  const ids = (res: { json(): { items: { id: string }[] } }) => res.json().items.map((l) => l.id);

  describe('GET /calls', () => {
    it('lists legs newest first, ties broken by id, with the public fields', async () => {
      const res = await call(a.owner, 'GET', '/calls');
      expect(res.statusCode).toBe(200);
      const tiedDesc = [...tied].sort().reverse();
      expect(ids(res)).toEqual([...tiedDesc, missed.id, internal.id, outgoing.id, forwardLeg.id, incoming.id]);
      expect(res.json().nextCursor).toBeNull();
      const out = res.json().items.find((l: { id: string }) => l.id === outgoing.id);
      expect(out).toMatchObject({
        callId: outgoing.callId, parentId: null, direction: 'outgoing', fromNumber: '+15165550100',
        toNumber: '+442071234567', did: '+15165550100', fromExtension: '102', toExtension: null,
        startedAt: '2026-11-02T09:30:00.000Z', billableSec: 60, outcome: 'answered', voicemail: false,
        cost: 0.020576, charge: 0.123456, recordingUrl: null,
      });
      // Course spec §5: CDRs include cost (what we pay) and charge (what we bill).
      expect(out).not.toHaveProperty('pbxNode');
      const inc = res.json().items.find((l: { id: string }) => l.id === incoming.id);
      expect(inc.recordingUrl).toBe(`/calls/${incoming.callId}/recording`);
    });

    it('filters by direction, outcome, extension, number and time range', async () => {
      const q = async (query: string) => ids(await call(a.owner, 'GET', `/calls?${query}`));
      expect(await q('direction=outgoing')).toEqual([outgoing.id, forwardLeg.id]);
      expect(await q('outcome=busy')).toEqual([internal.id]);
      expect(await q('extension=101')).toEqual([...[...tied].sort().reverse(), internal.id, incoming.id]);
      // Partial number, any formatting; matches from, to or did.
      expect(await q(`number=${encodeURIComponent('(917) 555-01')}`)).toEqual([forwardLeg.id]);
      expect(await q('number=2071234')).toEqual([outgoing.id]);
      expect(await q('from=2026-11-02T00:00:00Z&to=2026-11-04T00:00:00Z')).toEqual([internal.id, outgoing.id]);
      expect(await q('direction=incoming&outcome=no_answer&number=312')).toEqual([missed.id]);
    });

    it('pages with a cursor, visiting every leg exactly once', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await call(a.owner, 'GET', `/calls?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode).toBe(200);
        seen.push(...ids(res));
        cursor = res.json().nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(4);
      expect(seen).toEqual(ids(await call(a.owner, 'GET', '/calls')));
    });

    it('rejects bad queries', async () => {
      for (const query of ['cursor=garbage', 'direction=sideways', 'extension=abc', 'number=---', 'from=2026-11-05T00:00:00Z&to=2026-11-01T00:00:00Z', 'limit=0', 'limit=201']) {
        const res = await call(a.owner, 'GET', `/calls?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().error).toBe('invalid_request');
      }
    });

    it('shows staff only the calls of their own extensions', async () => {
      const mine = ids(await call(a.staff, 'GET', '/calls'));
      expect(mine).toEqual([...[...tied].sort().reverse(), internal.id, incoming.id]);
      expect(ids(await call(a.other, 'GET', '/calls'))).toEqual([]);
      expect(ids(await call(a.staff, 'GET', '/calls?direction=outgoing'))).toEqual([]);
    });

    it("never shows another account's calls", async () => {
      const bIds = ids(await call(b.owner, 'GET', '/calls'));
      expect(bIds).toHaveLength(1);
      expect(bIds).not.toContain(incoming.id);
    });
  });

  describe('GET /calls/:callId and its recording', () => {
    it('returns every leg, main leg first', async () => {
      const res = await call(a.owner, 'GET', `/calls/${incoming.callId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ callId: incoming.callId, recordingUrl: `/calls/${incoming.callId}/recording` });
      expect(res.json().legs.map((l: { id: string }) => l.id)).toEqual([incoming.id, forwardLeg.id]);
      // Staff whose extension is on the call see all of it, including the external leg.
      expect((await call(a.staff, 'GET', `/calls/${incoming.callId}`)).json().legs).toHaveLength(2);
    });

    it('is 404 for unknown calls, other accounts and other staff', async () => {
      expect((await call(a.owner, 'GET', `/calls/${randomUUID()}`)).statusCode).toBe(404);
      expect((await call(b.owner, 'GET', `/calls/${incoming.callId}`)).statusCode).toBe(404);
      expect((await call(a.staff, 'GET', `/calls/${outgoing.callId}`)).statusCode).toBe(404);
      expect((await call(a.other, 'GET', `/calls/${incoming.callId}`)).statusCode).toBe(404);
    });

    it('streams the recording to whoever may see the call', async () => {
      for (const u of [a.owner, a.staff]) {
        const res = await call(u, 'GET', `/calls/${incoming.callId}/recording`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('audio/wav');
        expect(res.body).toMatch(/^RIFF-recording-/);
      }
      expect((await call(a.other, 'GET', `/calls/${incoming.callId}/recording`)).statusCode).toBe(404);
      expect((await call(b.owner, 'GET', `/calls/${incoming.callId}/recording`)).statusCode).toBe(404);
      const none = await call(a.owner, 'GET', `/calls/${outgoing.callId}/recording`);
      expect(none.statusCode).toBe(404);
      expect(none.json().message).toMatch(/no recording/);
    });
  });

  describe('voicemails', () => {
    it('lists newest first with filters, and staff see only their mailboxes', async () => {
      const t = await makeTenant();
      const v1 = await voicemail(t, t.boxes.staff, '2026-11-01T00:00:00Z');
      const v2 = await voicemail(t, t.boxes.ext, '2026-11-02T00:00:00Z', true);
      const v3 = await voicemail(t, t.boxes.main, '2026-11-03T00:00:00Z');

      const all = await call(t.owner, 'GET', '/voicemails');
      expect(ids(all)).toEqual([v3.id, v2.id, v1.id]);
      expect(all.json().items[0]).toEqual({
        id: v3.id, mailboxId: t.boxes.main, mailboxName: 'Main', callerNumber: '+12015550123', callId: v3.callId,
        heard: false, durationMs: 4200, createdAt: '2026-11-03T00:00:00.000Z', audioUrl: `/voicemails/${v3.id}/audio`,
      });
      expect(ids(await call(t.owner, 'GET', '/voicemails?heard=false'))).toEqual([v3.id, v1.id]);
      expect(ids(await call(t.owner, 'GET', `/voicemails?mailboxId=${t.boxes.ext}`))).toEqual([v2.id]);
      const paged = await call(t.owner, 'GET', '/voicemails?limit=2');
      expect(ids(paged)).toEqual([v3.id, v2.id]);
      expect(ids(await call(t.owner, 'GET', `/voicemails?limit=2&cursor=${paged.json().nextCursor}`))).toEqual([v1.id]);

      // Staff: the mailbox they own + their extension's mailbox, not "Main".
      expect(ids(await call(t.staff, 'GET', '/voicemails'))).toEqual([v2.id, v1.id]);
      expect(ids(await call(t.other, 'GET', '/voicemails'))).toEqual([]);
      expect((await call(t.staff, 'GET', `/voicemails/${v3.id}`)).statusCode).toBe(404);
      expect((await call(t.staff, 'GET', `/voicemails/${v3.id}/audio`)).statusCode).toBe(404);
      expect((await call(a.owner, 'GET', `/voicemails/${v1.id}`)).statusCode).toBe(404); // other account
    });

    it('marks heard and new, shared with *98 through the row', async () => {
      const t = await makeTenant();
      const v = await voicemail(t, t.boxes.staff, '2026-11-01T00:00:00Z');
      const heard = await call(t.staff, 'PATCH', `/voicemails/${v.id}`, { heard: true });
      expect(heard.statusCode).toBe(200);
      expect(heard.json()).toMatchObject({ id: v.id, heard: true });
      expect((await sql`select heard from voicemails where id = ${v.id}`)[0]).toEqual({ heard: true });
      expect((await call(t.owner, 'PATCH', `/voicemails/${v.id}`, { heard: false })).json().heard).toBe(false);

      expect((await call(t.owner, 'PATCH', `/voicemails/${v.id}`, { heard: 'yes' })).statusCode).toBe(400);
      expect((await call(t.owner, 'PATCH', `/voicemails/${v.id}`, { heard: true, mailboxId: randomUUID() })).statusCode).toBe(400);
      expect((await call(t.other, 'PATCH', `/voicemails/${v.id}`, { heard: true })).statusCode).toBe(404);
      expect((await call(a.owner, 'PATCH', `/voicemails/${v.id}`, { heard: true })).statusCode).toBe(404);
    });

    it('plays the audio, and delete removes message, media row and file', async () => {
      const t = await makeTenant();
      const v = await voicemail(t, t.boxes.ext, '2026-11-01T00:00:00Z');
      const play = await call(t.staff, 'GET', `/voicemails/${v.id}/audio`);
      expect(play.statusCode).toBe(200);
      expect(play.body).toBe(`RIFF-voicemail-${v.mediaId}`);
      const part = await app.inject({ method: 'GET', url: `/voicemails/${v.id}/audio`, cookies: t.owner.cookies, headers: { range: 'bytes=0-3' } });
      expect(part.statusCode).toBe(206);
      expect(part.body).toBe('RIFF');

      expect((await call(t.other, 'DELETE', `/voicemails/${v.id}`)).statusCode).toBe(404);
      expect((await call(t.staff, 'DELETE', `/voicemails/${v.id}`)).statusCode).toBe(204);
      expect(await sql`select 1 from voicemails where id = ${v.id}`).toHaveLength(0);
      expect(await sql`select 1 from media where id = ${v.mediaId}`).toHaveLength(0);
      expect(store.objects.has(v.key)).toBe(false);
      expect((await call(t.staff, 'DELETE', `/voicemails/${v.id}`)).statusCode).toBe(404);
    });

    it('deleting a mailbox also deletes its voicemail audio', async () => {
      const t = await makeTenant();
      const v = await voicemail(t, t.boxes.staff, '2026-11-01T00:00:00Z');
      const kept = await voicemail(t, t.boxes.main, '2026-11-01T00:00:00Z');
      expect((await call(t.owner, 'DELETE', `/mailboxes/${t.boxes.staff}`)).statusCode).toBe(204);
      expect(await sql`select 1 from media where id = ${v.mediaId}`).toHaveLength(0);
      expect(store.objects.has(v.key)).toBe(false);
      expect(await sql`select 1 from media where id = ${kept.mediaId}`).toHaveLength(1);
      expect(store.objects.has(kept.key)).toBe(true);
    });
  });

  describe('GET /settings', () => {
    it('shows add-ons and allowances to any user; defaults without a settings row', async () => {
      const t = await makeTenant();
      const empty = await call(t.staff, 'GET', '/settings');
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({ recordCalls: false, intlCalling: false, includedUsMinutes: 0, includedExtensions: 0, extraExtensions: 0 });

      await sql`insert into tenant_settings (tenant_id, record_calls, intl_calling, included_us_minutes, included_extensions, extra_extensions)
                values (${t.id}, true, true, 100, 2, 1)`;
      expect((await call(t.owner, 'GET', '/settings')).json()).toEqual({
        recordCalls: true, intlCalling: true, includedUsMinutes: 100, includedExtensions: 2, extraExtensions: 1,
      });
    });

    it('has no write route (add-ons are bought through billing)', async () => {
      expect((await call(a.owner, 'PUT', '/settings', { recordCalls: true })).statusCode).toBe(404);
    });
  });
});
