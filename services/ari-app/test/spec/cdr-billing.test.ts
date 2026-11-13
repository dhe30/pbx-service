import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CALL_PRICING } from '@pbx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdrWriter } from '../../src/cdr.js';
import { log } from '../../src/log.js';
import type { PendingCdr } from '../../src/repo.js';
import { Account, makeHarness, nextDid, startDb, until, type Db } from '../harness/env.js';

// Course spec §5 "Call records and billing":
//  CDRs: account, direction (incoming, outgoing, internal), calling and called numbers, DID and
//  extensions, start/answer/end, billable duration, outcome (answered, busy, no answer, failed,
//  blocked), vendor (outgoing), cost (what you pay), charge (what you bill). Rate by longest prefix.
//  Usage: every external leg is charged; US calls use the plan's shared included minutes, then per
//  minute; other destinations and incoming toll-free always per minute; everything else free.
//  30/6 increments.
// §4 Search: "... includes just-ended calls, fast with millions of calls."

let db: Db;
beforeAll(async () => {
  db = await startDb();
  await db.sql`insert into rate_decks (vendor, prefix, destination, per_min) values
    ('us', '1', 'US', 0.012), ('intl', '44', 'United Kingdom', 0.02)`;
});
afterAll(async () => db?.close());

function leg(a: Account, fields: Partial<PendingCdr>): PendingCdr {
  const start = new Date('2026-11-04T15:00:00Z');
  return {
    id: randomUUID(),
    callId: randomUUID(),
    parentId: null,
    tenantId: a.id,
    direction: 'outgoing',
    fromNumber: '+12015550100',
    toNumber: '+12015550199',
    did: '+12015550100',
    fromExtension: '101',
    toExtension: null,
    startedAt: start.toISOString(),
    answeredAt: new Date(start.getTime() + 2000).toISOString(),
    endedAt: new Date(start.getTime() + 2000 + 95_000).toISOString(), // 95 s answered
    outcome: 'answered',
    vendor: 'us',
    ratePrefix: '1',
    voicemail: false,
    hangupCause: 16,
    pbxNode: 'pbx-test',
    chargeClass: 'us',
    costPerMin: 0.012,
    periodStart: '2026-11-02',
    includedAllowanceSec: 0,
    ...fields,
  };
}

const writer = () => new CdrWriter(null, makeHarness(db.sql).ctx.repo, async () => DEFAULT_CALL_PRICING, log, 5);

describe('§5 Rating', () => {
  it('US beyond included minutes: 30/6 billable, charge at our US rate, cost = vendor per second', async () => {
    const a = await new Account(db.sql).create();
    const w = writer();
    await w.submit(leg(a, {}));
    await w.drain();
    const [r] = await a.cdrs();
    expect(r!.billableSec).toBe(96); // 95 s -> 30 + 11 x 6
    expect(Number(r!.charge)).toBeCloseTo((96 * DEFAULT_CALL_PRICING.usPerMin) / 60, 6);
    expect(Number(r!.cost)).toBeCloseTo((95 * 0.012) / 60, 6); // vendors bill per second answered
  });

  it('US calls use the account’s SHARED included minutes first, across calls, per billing period', async () => {
    const a = await new Account(db.sql).create({ includedUsMinutes: 2 });
    const w = writer();
    const allowance = 120;
    // 3 calls of 30 s billable (1 s answered each): 30 + 30 + 30 + 30 = 120 included, 5th is charged.
    for (let i = 0; i < 5; i++) {
      const s = new Date(Date.UTC(2026, 10, 4, 15, i));
      await w.submit(leg(a, { startedAt: s.toISOString(), answeredAt: s.toISOString(), endedAt: new Date(s.getTime() + 1000).toISOString(), includedAllowanceSec: allowance }));
    }
    // A call in the NEXT period has a fresh allowance.
    const next = new Date('2026-11-10T15:00:00Z');
    await w.submit(leg(a, { startedAt: next.toISOString(), answeredAt: next.toISOString(), endedAt: new Date(next.getTime() + 1000).toISOString(), periodStart: '2026-11-09', includedAllowanceSec: allowance }));
    await w.drain();
    const rows = await a.cdrs();
    expect(rows.map((r) => r.includedSec)).toEqual([30, 30, 30, 30, 0, 30]);
    expect(rows.map((r) => Number(r.charge) > 0)).toEqual([false, false, false, false, true, false]);
    const usage = await db.sql`select period_start::text, included_sec_used::int from usage_periods where tenant_id = ${a.id} order by 1`;
    expect([...usage]).toEqual([
      { periodStart: '2026-11-02', includedSecUsed: 120 },
      { periodStart: '2026-11-09', includedSecUsed: 30 },
    ]);
  });

  it('a leg partly covered by included minutes is charged only for the rest', async () => {
    const a = await new Account(db.sql).create();
    const w = writer();
    await w.submit(leg(a, { includedAllowanceSec: 60 })); // 96 billable, 60 included
    await w.drain();
    const [r] = await a.cdrs();
    expect(r!.includedSec).toBe(60);
    expect(Number(r!.charge)).toBeCloseTo((36 * DEFAULT_CALL_PRICING.usPerMin) / 60, 6);
  });

  it('international: always per minute at vendor rate x multiplier (>= floor), never above the ceiling', async () => {
    const a = await new Account(db.sql).create({ includedUsMinutes: 100 });
    const w = writer();
    await w.submit(leg(a, { vendor: 'intl', chargeClass: 'intl', costPerMin: 0.02, ratePrefix: '44', toNumber: '+442071234567', includedAllowanceSec: 6000 }));
    await w.drain();
    const [r] = await a.cdrs();
    expect(r!.includedSec).toBe(0);
    const perMin = Math.max(DEFAULT_CALL_PRICING.intlMinPerMin, 0.02 * DEFAULT_CALL_PRICING.intlMultiplier);
    expect(Number(r!.charge)).toBeCloseTo((96 * perMin) / 60, 6);
    expect(perMin).toBeLessThanOrEqual(Math.max(0.06, 6 * 0.02));
  });

  it('incoming toll-free: always per minute; incoming local and internal: free', async () => {
    const a = await new Account(db.sql).create();
    const w = writer();
    await w.submit(leg(a, { direction: 'incoming', vendor: null, chargeClass: 'toll_free_in', costPerMin: 0.025 }));
    await w.submit(leg(a, { direction: 'incoming', vendor: null, chargeClass: 'incoming', costPerMin: 0 }));
    await w.submit(leg(a, { direction: 'internal', vendor: null, chargeClass: 'internal', costPerMin: 0 }));
    await w.drain();
    const rows = await a.cdrs();
    const tf = rows.find((r) => r.charge !== '0.000000')!;
    expect(Number(tf.charge)).toBeCloseTo((96 * DEFAULT_CALL_PRICING.tollFreeInPerMin) / 60, 6);
    expect(Number(tf.cost)).toBeCloseTo((95 * 0.025) / 60, 6);
    expect(rows.filter((r) => r.charge === '0.000000')).toHaveLength(2);
  });

  it('unanswered legs bill nothing', async () => {
    const a = await new Account(db.sql).create();
    const w = writer();
    await w.submit(leg(a, { answeredAt: null, outcome: 'no_answer' }));
    await w.drain();
    expect((await a.cdrs())[0]).toMatchObject({ billableSec: 0, charge: '0.000000', cost: '0.000000' });
  });
});

describe('§5 CDR durability (B6)', () => {
  it('a replayed spool file is inserted once and never consumes included minutes twice', async () => {
    const a = await new Account(db.sql).create();
    const c = leg(a, { includedAllowanceSec: 600 });
    const w = writer();
    await w.submit(c);
    await w.drain();
    await w.submit(c); // crash after insert, before the spool file was deleted -> replay
    await w.drain();
    expect(await a.cdrs()).toHaveLength(1);
    const [u] = await db.sql<{ used: number }[]>`select included_sec_used::int as used from usage_periods where tenant_id = ${a.id}`;
    expect(u!.used).toBe(96);
  });

  it('spooled legs survive a process restart (files replayed on start)', async () => {
    const a = await new Account(db.sql).create();
    const dir = mkdtempSync(join(tmpdir(), 'cdr-'));
    try {
      const repo = makeHarness(db.sql).ctx.repo;
      const failing = { insertCdrs: async () => Promise.reject(new Error('db down')) } as unknown as typeof repo;
      const w1 = new CdrWriter(dir, failing, async () => DEFAULT_CALL_PRICING, log, 5);
      await w1.submit(leg(a, {}));
      w1.stop();
      expect(readdirSync(dir).filter((f) => f.endsWith('.cdr.json'))).toHaveLength(1);
      const w2 = new CdrWriter(dir, repo, async () => DEFAULT_CALL_PRICING, log, 5);
      await w2.start();
      await w2.drain();
      w2.stop();
      expect(await a.cdrs()).toHaveLength(1);
      expect(readdirSync(dir).filter((f) => f.endsWith('.cdr.json'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a just-ended call is in Postgres (searchable) within about a second', async () => {
    const h = makeHarness(db.sql, { CDR_FLUSH_MS: '250' });
    const real = new CdrWriter(null, h.ctx.repo, async () => DEFAULT_CALL_PRICING, log, h.ctx.cfg.CDR_FLUSH_MS);
    h.ctx.cdr = real;
    await real.start();
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 2 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.peerOf(caller));
    h.ari.remoteHangup(caller);
    const t0 = Date.now();
    await until(async () => (await a.cdrs()).length === 1, 3000, 'CDR visible');
    expect(Date.now() - t0).toBeLessThan(1000);
    real.stop();
  });
});

describe('§5 CDR content of real calls', () => {
  it('incoming answered call: all spec fields filled', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id }, 'toll_free', 0.025);
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 2 });
    const caller = h.ari.carrierCall(did.slice(1), '6315550000'); // carrier digits without '+', 10-digit caller
    await until(() => h.ari.peerOf(caller));
    h.ari.remoteHangup(caller);
    await h.settle();
    const [r] = await a.cdrs();
    expect(r).toMatchObject({
      direction: 'incoming',
      fromNumber: '+16315550000',
      toNumber: did,
      did,
      toExtension: '101',
      outcome: 'answered',
      vendor: null,
      billableSec: 30,
    });
    expect(r!.answeredAt).not.toBeNull();
    expect(r!.endedAt.getTime()).toBeGreaterThanOrEqual(r!.answeredAt!.getTime());
    expect(Number(r!.charge)).toBeGreaterThan(0); // toll-free incoming
  });

  it('call recording add-on: the recording is filed against the call (media.call_id = cdrs.call_id)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create({ recordCalls: true });
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 2 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.peerOf(caller));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rec = h.uploads.begun.find((u) => u.kind === 'recording')!;
    const [r] = await a.cdrs();
    expect(rec.callId).toBe(r!.callId);
    await h.ctx.repo.saveUploadedRecording({ mediaId: rec.mediaId, tenantId: a.id, kind: 'recording', objectKey: 'k', durationMs: 1000, callId: rec.callId, mailboxId: null });
    const joined = await db.sql`select m.id from cdrs c join media m on m.call_id = c.call_id where c.id = ${r!.id}`;
    expect(joined).toHaveLength(1);
  });

  it('no recording without the add-on', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create({ recordCalls: false });
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 2 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.peerOf(caller));
    h.ari.remoteHangup(caller);
    await h.settle();
    expect(h.uploads.begun.filter((u) => u.kind === 'recording')).toHaveLength(0);
  });
});
