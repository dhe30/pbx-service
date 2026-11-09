import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, startDb, until, type Db } from '../harness/env.js';

// Course spec §3 "Hold and transfer (blind and attended) from desk phones and the softphone."
// §4 softphone: softphone-hold (toggle), softphone-transfer-blind, softphone-transfer-attended
// ("holds the call and calls the target"), softphone-transfer-complete.
// §5 "Every leg you place to an external number is charged ... (dialed, forwarded, simultaneous
// ring, transferred)."

let db: Db;
beforeAll(async () => {
  db = await startDb();
  await db.sql`insert into rate_decks (vendor, prefix, destination, per_min) values ('us', '1', 'US', 0.01)`;
});
afterAll(async () => db?.close());

/** A PSTN caller connected to extension 101 (agent). Returns the caller and agent channels. */
async function connectedCall(opts: { recordCalls?: boolean } = {}) {
  const h = makeHarness(db.sql);
  const a = await new Account(db.sql).create({ recordCalls: opts.recordCalls ?? false });
  await a.extension({ number: '101' });
  await a.extension({ number: '102' });
  const did = nextDid();
  await a.number(did, { type: 'extension', id: a.ext['101']!.id });
  h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
  h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
  const caller = h.ari.carrierCall(did, '+16315550000');
  const agent = await until(() => h.ari.peerOf(caller), 3000, 'connected');
  return { h, a, did, caller, agent };
}

describe('§3 Hold', () => {
  it('agent holds -> caller hears music on hold; resume -> music stops; transfer handling is ARI-only', async () => {
    const { h, caller, agent } = await connectedCall();
    expect(h.ari.channels.get(agent)!.vars['PJSIP_TRANSFER_HANDLING()']).toBe('ari-only');
    h.ari.hold(agent);
    await until(() => h.ari.channels.get(caller)!.moh, 2000, 'MOH on');
    h.ari.unhold(agent);
    await until(() => !h.ari.channels.get(caller)!.moh, 2000, 'MOH off');
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('a phone that placed an outgoing call can hold too (MOH to the PSTN party)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.number(nextDid(), null);
    await a.extension({ number: '101' });
    h.ari.external.set('+12015550123', { answerAfterMs: 5 });
    const ph = h.ari.deviceCall(a.ext['101']!.sip, '2015550123');
    const vendor = await until(() => h.ari.peerOf(ph));
    h.ari.hold(ph);
    await until(() => h.ari.channels.get(vendor)!.moh);
    h.ari.remoteHangup(ph);
    await h.settle();
  });

  it('recording keeps running while held (recorded call)', async () => {
    const { h, caller, agent } = await connectedCall({ recordCalls: true });
    await until(() => h.ari.recordings.size === 1, 2000, 'recording started');
    h.ari.hold(agent);
    await until(() => h.ari.channels.get(caller)!.moh);
    expect(h.ari.recordings.size).toBe(1);
    h.ari.remoteHangup(caller);
    await h.settle();
    expect(h.uploads.begun.find((u) => u.kind === 'recording')).toBeTruthy();
  });
});

describe('§3 Blind transfer', () => {
  it('to another extension: the transferring phone drops, the caller rings 102 and is connected', async () => {
    const { h, a, caller, agent } = await connectedCall();
    h.ari.referBlind(agent, '102');
    const leg102 = await until(() => h.ari.legsTo(a.ext['102']!.sip)[0], 2000, 'rings 102');
    await until(() => h.ari.peerOf(caller) === leg102.id, 2000, 'caller bridged to 102');
    expect(h.ari.transferProgressLog).toContainEqual({ channelId: agent, state: 'channel_answered' });
    expect(h.ari.channels.has(agent)).toBe(false);
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'answered', toExtension: '102' });
  });

  it('to an external number: charged as its own outgoing leg', async () => {
    const { h, a, caller, agent, did } = await connectedCall();
    h.ari.external.set('+12015553333', { answerAfterMs: 5 });
    h.ari.referBlind(agent, '2015553333');
    const ext = await until(() => h.ari.legsTo('+12015553333')[0]);
    expect(ext.callerId).toBe(did);
    await until(() => h.ari.peerOf(caller) === ext.id);
    h.ari.remoteHangup(ext.id);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ direction: 'outgoing', toNumber: '+12015553333', outcome: 'answered', vendor: 'us' });
  });

  it('target does not answer -> the caller goes to the target extension’s voicemail', async () => {
    const { h, a, caller, agent } = await connectedCall();
    h.ari.sip.set(a.ext['102']!.sip, { failCause: 20 });
    h.ari.referBlind(agent, '102');
    await until(() => h.uploads.begun.find((u) => u.mailboxId === a.ext['102']!.mailboxId));
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('the phone that placed an outgoing call transfers it: the PSTN party is routed on', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.number(nextDid(), null);
    await a.extension({ number: '101' });
    await a.extension({ number: '102' });
    h.ari.external.set('+12015550123', { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    const ph = h.ari.deviceCall(a.ext['101']!.sip, '2015550123');
    const vendor = await until(() => h.ari.peerOf(ph));
    h.ari.referBlind(ph, '102');
    const leg = await until(() => h.ari.legsTo(a.ext['102']!.sip)[0]);
    await until(() => h.ari.peerOf(vendor) === leg.id);
    h.ari.remoteHangup(vendor);
    await h.settle();
    // The outgoing (vendor) leg is billed until the PSTN party actually hung up.
    const [main] = await a.cdrs();
    expect(main).toMatchObject({ direction: 'outgoing', outcome: 'answered' });
  });
});

describe('§3 Attended transfer', () => {
  it('agent holds the caller, calls 102 (consult), completes: caller <-> 102, both agent legs drop', async () => {
    const { h, a, caller, agent } = await connectedCall();
    // softphone-transfer-attended: hold + call the target
    h.ari.hold(agent);
    await until(() => h.ari.channels.get(caller)!.moh);
    const consult = h.ari.deviceCall(a.ext['101']!.sip, '102');
    const target = await until(() => h.ari.peerOf(consult), 2000, 'consult connected');
    // softphone-transfer-complete: REFER on the first call, Replaces = the consult call
    h.ari.referAttended(agent, consult);
    await until(() => h.ari.peerOf(caller) === target, 2000, 'caller joined with 102');
    expect(h.ari.channels.get(caller)!.moh).toBe(false);
    await until(() => !h.ari.channels.has(agent) && !h.ari.channels.has(consult), 2000, 'agent legs dropped');
    expect(h.ari.transferProgressLog).toContainEqual({ channelId: agent, state: 'channel_answered' });
    // The joined call keeps working: 102 hangs up -> caller is hung up too, everything ends.
    h.ari.remoteHangup(target);
    await until(() => !h.ari.channels.has(caller));
    await h.settle();
    const rows = await a.cdrs();
    expect(rows.filter((r) => r.direction === 'incoming')).toHaveLength(1);
    expect(rows.filter((r) => r.direction === 'internal')).toHaveLength(1);
    expect(h.ctx.conversations.size).toBe(0);
    expect(h.ctx.bus.size).toBe(0); // no leaked subscriptions
  });

  it('attended transfer to an external number: the consult leg is still billed until it really ends', async () => {
    const { h, a, caller, agent } = await connectedCall();
    await a.number(nextDid(), null);
    h.ctx.cache.invalidateTenant(a.id);
    h.ari.external.set('+12015552222', { answerAfterMs: 5 });
    h.ari.hold(agent);
    const consult = h.ari.deviceCall(a.ext['101']!.sip, '2015552222');
    const target = await until(() => h.ari.peerOf(consult));
    h.ari.referAttended(agent, consult);
    await until(() => h.ari.peerOf(caller) === target);
    await new Promise((r) => setTimeout(r, 30));
    h.ari.remoteHangup(caller);
    await h.settle();
    const out = (await a.cdrs()).find((r) => r.direction === 'outgoing')!;
    expect(out).toMatchObject({ toNumber: '+12015552222', outcome: 'answered' });
    expect(out.endedAt.getTime()).toBeGreaterThanOrEqual(out.answeredAt!.getTime() + 25);
  });
});
