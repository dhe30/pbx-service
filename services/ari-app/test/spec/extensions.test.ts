import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, startDb, until, type Db } from '../harness/env.js';

// Course spec §3 "Extensions":
//   "... voicemail box, and forwarding (always, busy, no answer) to an extension or external number.
//    Any number of phones register ... A call rings all of an extension's devices, its softphone,
//    and its listed external numbers at once; the first answer wins and the rest stop.
//    Extensions dial each other by number."

let db: Db;
beforeAll(async () => {
  db = await startDb();
  await db.sql`insert into rate_decks (vendor, prefix, destination, per_min) values ('us', '1', 'US', 0.01), ('us', '1201', 'US NJ', 0.008)`;
});
afterAll(async () => db?.close());

async function setup(extra: Parameters<Account['extension']>[0] = { number: '101' }) {
  const h = makeHarness(db.sql);
  const a = await new Account(db.sql).create({ includedUsMinutes: 0 });
  const ext = await a.extension(extra);
  const did = nextDid();
  await a.number(did, { type: 'extension', id: ext });
  return { h, a, ext, did };
}

describe('§3 Extensions: ringing', () => {
  it('rings the devices (one fork via Kamailio) AND every listed external number at once', async () => {
    const { h, a, did } = await setup({ number: '101', externalNumbers: ['+12015557001', '+12015557002'] });
    const sip = a.ext['101']!.sip;
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.originates.length === 3, 2000, '3 legs');
    const kinds = h.ari.originates.map((o) => (o.target.kind === 'sip' ? `sip:${o.target.user}` : `ext:${o.target.number}`)).sort();
    expect(kinds).toEqual(['ext:+12015557001', 'ext:+12015557002', `sip:${sip}`].sort());
    // Devices are reached through the first edge trunk; external numbers through the US vendor.
    expect(h.ari.originates.find((o) => o.target.kind === 'sip')!.endpoint).toBe(`PJSIP/${sip}@edge-a`);
    expect(h.ari.originates.find((o) => o.target.kind === 'external')!.endpoint).toMatch(
      /^PJSIP\/vendor-us-edge-a\/sip:\+12015557001@us-vendor\.cse356\.compas\.cs\.stonybrook\.edu$/,
    );
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('first answer wins; the other legs are hung up', async () => {
    const { h, a, did } = await setup({ number: '101', externalNumbers: ['+12015557001'] });
    h.ari.external.set('+12015557001', { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 80 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    const ext = await until(() => h.ari.legsTo('+12015557001')[0]);
    await until(() => h.ari.peerOf(caller) === ext.id, 2000, 'bridged to the external number');
    const sipLeg = h.ari.originates.find((o) => o.target.kind === 'sip')!;
    await until(() => h.ari.destroyed.has(sipLeg.channelId), 2000, 'device leg stopped');
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    // Main incoming row + one charged outgoing leg for the external number.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ direction: 'incoming', outcome: 'answered', parentId: null });
    expect(rows[1]).toMatchObject({ direction: 'outgoing', outcome: 'answered', parentId: rows[0]!.id, toNumber: '+12015557001', vendor: 'us', ratePrefix: '1201' });
    expect(rows[1]!.callId).toBe(rows[0]!.callId);
    // "present one of the account's numbers as caller ID": the DID that was called.
    expect(h.ari.originates.find((o) => o.target.kind === 'external')!.callerId).toBe(did);
  });

  it('an unanswered external leg of a simultaneous ring is its own CDR row (no answer, no charge)', async () => {
    const { h, a, did } = await setup({ number: '101', externalNumbers: ['+12015557001'] });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.peerOf(caller));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows[1]).toMatchObject({ direction: 'outgoing', outcome: 'no_answer', billableSec: 0, charge: '0.000000' });
  });

  it('when the first edge is down, legs fail over to the next trunk', async () => {
    const { h, a, did } = await setup();
    h.ari.deadTrunks.add('edge-a');
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.peerOf(caller));
    expect(h.ari.originates[0]!.endpoint).toBe(`PJSIP/${a.ext['101']!.sip}@edge-b`);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('no registered device (480 -> cause 20) counts as no answer and goes to voicemail', async () => {
    const { h, a, did } = await setup();
    h.ari.sip.set(a.ext['101']!.sip, { failCause: 20 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.kind === 'voicemail'), 2000, 'voicemail recording');
    expect(h.uploads.begun[0]).toMatchObject({ mailboxId: a.ext['101']!.mailboxId, callerNumber: '+16315550000' });
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'no_answer', voicemail: true });
  });
});

describe('§3 Extensions: forwarding', () => {
  it('forward always -> another extension (the first extension never rings)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e102 = await a.extension({ number: '102' });
    const e101 = await a.extension({ number: '101', forwardAlways: { type: 'extension', id: e102 } });
    await a.number('+12015550111', { type: 'extension', id: e101 });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall('+12015550111', '+16315550000');
    await until(() => h.ari.peerOf(caller));
    expect(h.ari.legsTo(a.ext['101']!.sip)).toHaveLength(0);
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'answered', toExtension: '102' });
  });

  it('forward always -> external number is a charged outgoing leg', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e101 = await a.extension({ number: '101', forwardAlways: { type: 'external', number: '+12015558888' } });
    await a.number('+12015550112', { type: 'extension', id: e101 });
    h.ari.external.set('+12015558888', { answerAfterMs: 5 });
    const caller = h.ari.carrierCall('+12015550112', '+16315550000');
    await until(() => h.ari.peerOf(caller));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows[1]).toMatchObject({ direction: 'outgoing', toNumber: '+12015558888', vendor: 'us', outcome: 'answered' });
    expect(rows[1]!.billableSec).toBe(30); // minimum increment (30/6)
  });

  it('forward busy applies only when the devices are busy (486)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e103 = await a.extension({ number: '103' });
    const e101 = await a.extension({ number: '101', forwardBusy: { type: 'extension', id: e103 }, forwardNoAnswer: { type: 'external', number: '+12015559999' } });
    await a.number('+12015550113', { type: 'extension', id: e101 });
    h.ari.sip.set(a.ext['101']!.sip, { failCause: 17 });
    h.ari.sip.set(a.ext['103']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall('+12015550113', '+16315550000');
    await until(() => h.ari.peerOf(caller));
    expect(h.ari.legsTo('+12015559999')).toHaveLength(0);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('forward busy -> a voicemail box (another mailbox than the extension\'s own)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const shared = await a.mailbox('Front desk');
    const e101 = await a.extension({ number: '101', forwardBusy: { type: 'voicemail', id: shared } });
    await a.number('+12015550116', { type: 'extension', id: e101 });
    h.ari.sip.set(a.ext['101']!.sip, { failCause: 17 });
    const caller = h.ari.carrierCall('+12015550116', '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.kind === 'voicemail'), 2000, 'voicemail recording');
    expect(h.uploads.begun[0]).toMatchObject({ mailboxId: shared });
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'busy', voicemail: true });
  });

  it('busy with no forwardBusy -> the extension\'s own voicemail box', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e101 = await a.extension({ number: '101' });
    await a.number('+12015550117', { type: 'extension', id: e101 });
    h.ari.sip.set(a.ext['101']!.sip, { failCause: 17 });
    const caller = h.ari.carrierCall('+12015550117', '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.kind === 'voicemail'), 2000, 'voicemail recording');
    expect(h.uploads.begun[0]).toMatchObject({ mailboxId: a.ext['101']!.mailboxId });
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('forward no answer applies after the ring timeout', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e103 = await a.extension({ number: '103' });
    const e101 = await a.extension({ number: '101', ringTimeoutSec: 5, forwardNoAnswer: { type: 'extension', id: e103 } });
    await a.number('+12015550114', { type: 'extension', id: e101 });
    h.ari.sip.set(a.ext['103']!.sip, { answerAfterMs: 5 });
    const t0 = Date.now();
    const caller = h.ari.carrierCall('+12015550114', '+16315550000');
    await until(() => h.ari.peerOf(caller));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45); // 5 s ring timeout at TIME_SCALE 0.01
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('a forwarding loop ends instead of spinning (MAX_ROUTE_HOPS)', async () => {
    const h = makeHarness(db.sql, { MAX_ROUTE_HOPS: '5' });
    const a = await new Account(db.sql).create();
    const e1 = await a.extension({ number: '101' });
    const e2 = await a.extension({ number: '102', forwardAlways: { type: 'extension', id: e1 } });
    await db.sql`update extensions set forward_always = ${db.sql.json({ type: 'extension', id: e2 })} where id = ${e1}`;
    await a.number('+12015550115', { type: 'extension', id: e1 });
    const caller = h.ari.carrierCall('+12015550115', '+16315550000');
    await until(() => h.ari.destroyed.has(caller), 2000, 'caller hung up');
    await h.settle();
    expect(h.ari.originates).toHaveLength(0);
  });
});

describe('§3 Extensions dial each other by number', () => {
  it('internal call: 101 dials 102, CDR direction internal, no charge', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    await a.extension({ number: '102' });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    const ch = h.ari.deviceCall(a.ext['101']!.sip, '102');
    const leg = await until(() => h.ari.legsTo(a.ext['102']!.sip)[0]);
    await until(() => h.ari.peerOf(ch) === leg.id);
    // The callee's phone shows the caller's extension number.
    expect(h.ari.originates[0]!.callerId).toBe('101');
    h.ari.remoteHangup(leg.id);
    await h.settle();
    const [row] = await a.cdrs();
    expect(row).toMatchObject({ direction: 'internal', fromExtension: '101', toExtension: '102', outcome: 'answered', charge: '0.000000', vendor: null });
    expect(row!.answeredAt).not.toBeNull();
  });

  it('another account’s extension number is not reachable (numbers are per account)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const b = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    await b.extension({ number: '555' });
    const ch = h.ari.deviceCall(a.ext['101']!.sip, '555');
    await until(() => h.ari.destroyed.has(ch));
    await h.settle();
    expect(h.ari.originates).toHaveLength(0);
    expect(h.ari.hangups.find((x) => x.channelId === ch)?.reason).toBe('unallocated');
  });
});
