import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, startDb, until, type CdrRow, type Db } from '../harness/env.js';

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

  // Hussain Notary 2026-11-17 08:10 UTC ("extension 103 heard nothing", "no_audio at a phone that
  // takes PCMU"): the caller pressed 3 in the IVR and put the call on hold while 103 was ringing.
  // The hold came before the bridge existed, so 103 answered into silence (no MOH, and a held
  // caller sends nothing). docs/incidents/2026-11-17-hold-before-answer.md
  it('caller holds while the extension rings (IVR) -> the extension answers into music on hold', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '103' });
    const menu = await a.ivr({ options: { '3': { type: 'extension', id: a.ext['103']!.id } } });
    const did = nextDid();
    await a.number(did, { type: 'ivr_menu', id: menu });
    h.ari.sip.set(a.ext['103']!.sip, { answerAfterMs: 100 });
    const caller = h.ari.carrierCall(did, '+16315550155');
    await until(() => h.ari.channels.get(caller)?.answered, 2000, 'IVR answered');
    h.ari.dtmf(caller, '3');
    await until(() => h.ari.legsTo(a.ext['103']!.sip)[0], 2000, 'rings 103');
    h.ari.hold(caller);
    const agent = await until(() => h.ari.peerOf(caller), 3000, '103 connected');
    await until(() => h.ari.channels.get(agent)!.moh, 2000, 'MOH to 103');
    h.ari.unhold(caller);
    await until(() => !h.ari.channels.get(agent)!.moh, 2000, 'MOH off after resume');
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('caller holds and resumes before the extension answers -> no MOH', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 100 });
    const caller = h.ari.carrierCall(did, '+16315550156');
    await until(() => h.ari.legsTo(a.ext['101']!.sip)[0], 2000, 'rings 101');
    h.ari.hold(caller);
    h.ari.unhold(caller);
    const agent = await until(() => h.ari.peerOf(caller), 3000, '101 connected');
    await new Promise((r) => setTimeout(r, 100));
    expect(h.ari.channels.get(agent)!.moh).toBe(false);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('caller holds while a blind-transfer target rings -> the target answers into music on hold', async () => {
    // The 02:53 UTC call the same day: 102 blind-transferred to 153, the caller held during the ring.
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '102' });
    await a.extension({ number: '153' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['102']!.id });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['153']!.sip, { answerAfterMs: 100 });
    const caller = h.ari.carrierCall(did, '+16315550348');
    const agent = await until(() => h.ari.peerOf(caller), 3000, '102 connected');
    h.ari.referBlind(agent, '153');
    const leg153 = await until(() => h.ari.legsTo(a.ext['153']!.sip)[0], 2000, 'rings 153');
    h.ari.hold(caller);
    await until(() => h.ari.peerOf(caller) === leg153.id, 3000, '153 connected');
    await until(() => h.ari.channels.get(leg153.id)!.moh, 2000, 'MOH to 153');
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

// 2026-11-25: Asterisk aborted (heap corruption in softmix, ast_slinfactory_feed) on a recorded
// call: a bridge recording adds a Recorder member, and a 3-member bridge mixes with softmix.
// Recordings now come from a snoop channel on one party; the bridge keeps exactly 2 members.
describe('§3 Call recording (add-on) without a mixing bridge', () => {
  it('records a snoop on a party, never adds a member to the bridge, files the recording at hangup', async () => {
    const { h, caller } = await connectedCall({ recordCalls: true });
    await until(() => h.ari.recordings.size === 1, 2000, 'recording started');
    const [snoop] = h.ari.snoops;
    expect(snoop!.channelId).toBe(caller);
    expect(h.ari.channelRecordStarts).toEqual([{ name: expect.stringMatching(/^rec-/), channelId: snoop!.snoopId, beep: false, ifExists: 'overwrite' }]);
    for (const members of h.ari.bridges.values()) expect(members.size).toBeLessThanOrEqual(2);
    h.ari.remoteHangup(caller);
    await h.settle();
    const rec = h.uploads.begun.find((u) => u.kind === 'recording')!;
    expect(h.uploads.finished).toContain(rec.name);
    expect(h.ari.channels.has(snoop!.snoopId)).toBe(false);
    expect(h.ctx.bus.size).toBe(0);
  });

  it('attended transfer by the recorded party: recording continues on the party that stays (same file)', async () => {
    const { h, a, caller: b } = await connectedCall({ recordCalls: true });
    const out = h.ari.deviceCall(a.ext['101']!.sip, '102');
    const leg102 = await until(() => h.ari.peerOf(out), 2000, '102 connected');
    const outRec = await until(() => h.ari.channelRecordStarts.find((r) => h.ari.snoops.find((s) => s.snoopId === r.channelId)?.channelId === out), 2000, 'call 2 recorded');
    const a1 = await until(() => h.ari.peerOf(b));
    h.ari.referAttended(out, a1);
    await until(() => h.ari.peerOf(leg102) === b, 2000, '102 joined with B');
    const moved = await until(
      () => h.ari.channelRecordStarts.find((r) => r.name === outRec.name && r.ifExists === 'append'),
      2000,
      'recording moved',
    );
    expect(h.ari.snoops.find((s) => s.snoopId === moved.channelId)!.channelId).toBe(leg102);
    expect(h.ari.recordings.get(outRec.name)?.target).toBe(moved.channelId);
    for (const members of h.ari.bridges.values()) expect(members.size).toBeLessThanOrEqual(2);
    h.ari.remoteHangup(leg102);
    await until(() => !h.ari.channels.has(b));
    await h.settle();
    expect(h.uploads.finished).toContain(outRec.name);
    expect(h.uploads.finished.filter((n) => n === outRec.name)).toHaveLength(1);
    expect(h.ctx.bus.size).toBe(0);
  });

  it('a snoop that never enters Stasis: the call goes on unrecorded, nothing left behind', async () => {
    const h0 = makeHarness(db.sql);
    h0.ari.snoop = async () => {
      throw new Error('snoop refused');
    };
    const a = await new Account(db.sql).create({ recordCalls: true });
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    h0.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    const caller = h0.ari.carrierCall(did, '+16315550001');
    await until(() => h0.ari.peerOf(caller), 3000, 'connected');
    h0.ari.remoteHangup(caller);
    await h0.settle();
    expect(h0.uploads.finished).toHaveLength(0);
    expect(h0.ctx.bus.size).toBe(0);
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
    // The main row keeps who answered first; 102 has its own row from the transfer (§5 below).
    const rows = await a.cdrs();
    expect(rows[0]).toMatchObject({ outcome: 'answered', toExtension: '101', parentId: null });
    expect(rows[1]).toMatchObject({ outcome: 'answered', toExtension: '102', parentId: rows[0]!.id });
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

  it("to an extension that forwards always to the caller's own number: that extension rings", async () => {
    // Live 2026-11-15 (Zhang Animal Hospital): "extension 111 never rang after the transfer". 111
    // forwarded always to the caller's number, so the caller was connected to itself.
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    await a.extension({ number: '111', forwardAlways: { type: 'external', number: '+16315550132' } });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['111']!.sip, { answerAfterMs: 5 });
    h.ari.external.set('+16315550132', { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550132');
    const agent = await until(() => h.ari.peerOf(caller), 3000, 'connected');
    h.ari.referBlind(agent, '111');
    const leg111 = await until(() => h.ari.legsTo(a.ext['111']!.sip)[0], 2000, 'rings 111');
    await until(() => h.ari.peerOf(caller) === leg111.id, 2000, 'caller bridged to 111');
    expect(h.ari.legsTo('+16315550132')).toHaveLength(0);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('to an extension that forwards always to another number: that extension rings, no outside leg', async () => {
    // Live 2026-11-15 (Zhang Animal Hospital): "extension 109 never rang after the transfer
    // (REFER 202)". 109 forwards always to +16315550132; the caller was +16315550122.
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '103' });
    await a.extension({ number: '109', forwardAlways: { type: 'external', number: '+16315550132' } });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['103']!.id });
    h.ari.sip.set(a.ext['103']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['109']!.sip, { answerAfterMs: 5 });
    h.ari.external.set('+16315550132', { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550122');
    const agent = await until(() => h.ari.peerOf(caller), 3000, 'connected');
    h.ari.referBlind(agent, '109');
    const leg109 = await until(() => h.ari.legsTo(a.ext['109']!.sip)[0], 2000, 'rings 109');
    await until(() => h.ari.peerOf(caller) === leg109.id, 2000, 'caller bridged to 109');
    expect(h.ari.legsTo('+16315550132')).toHaveLength(0);
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows).toHaveLength(2); // main + transfer leg; no charged leg to the forward number
    expect(rows.filter((r) => r.direction === 'outgoing')).toHaveLength(0);
    expect(rows[0]).toMatchObject({ outcome: 'answered', toExtension: '103' });
    expect(rows[1]).toMatchObject({ outcome: 'answered', toExtension: '109', charge: '0.000000' });
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
    // What the target finds when it joins: never the transferring phone, never hold music
    // (live 2026-11-24: "225 heard the transferring extension for 3.0 s").
    const add = h.ari.addToBridge.bind(h.ari);
    let onJoin: { members: string[]; callerMoh: boolean } | null = null;
    h.ari.addToBridge = async (bridgeId: string, ids: string[]) => {
      if (ids.includes(target)) onJoin = { members: [...(h.ari.bridges.get(bridgeId) ?? [])], callerMoh: h.ari.channels.get(caller)!.moh };
      return add(bridgeId, ids);
    };
    // softphone-transfer-complete: REFER on the first call, Replaces = the consult call
    h.ari.referAttended(agent, consult);
    await until(() => h.ari.peerOf(caller) === target, 2000, 'caller joined with 102');
    expect(onJoin).toEqual({ members: [caller], callerMoh: false });
    expect(h.ari.channels.get(caller)!.moh).toBe(false);
    await until(() => !h.ari.channels.has(agent) && !h.ari.channels.has(consult), 2000, 'agent legs dropped');
    expect(h.ari.transferProgressLog).toContainEqual({ channelId: agent, state: 'channel_answered' });
    // The joined call keeps working: 102 hangs up -> caller is hung up too, everything ends.
    h.ari.remoteHangup(target);
    await until(() => !h.ari.channels.has(caller));
    await h.settle();
    const rows = await a.cdrs();
    expect(rows.filter((r) => r.direction === 'incoming')).toHaveLength(1);
    // The consult call (101 -> 102, its own call) + the incoming call's transfer leg to 102.
    expect(rows.filter((r) => r.direction === 'internal')).toHaveLength(2);
    expect(h.ctx.conversations.size).toBe(0);
    expect(h.ctx.bus.size).toBe(0); // no leaked subscriptions
  });

  it('consult call to an extension that forwards always: the extension itself rings', async () => {
    // Live 2026-11-15: 103 held a caller and called 111 (forward always to an outside number); the
    // consult went to that number and the transfer joined the caller with it, so 111 never rang.
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '103' });
    await a.extension({ number: '111', forwardAlways: { type: 'external', number: '+16315550132' } });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['103']!.id });
    h.ari.sip.set(a.ext['103']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['111']!.sip, { answerAfterMs: 5 });
    h.ari.external.set('+16315550132', { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550120');
    const agent = await until(() => h.ari.peerOf(caller), 3000, 'connected');
    h.ari.hold(agent);
    await until(() => h.ari.channels.get(caller)!.moh);
    const consult = h.ari.deviceCall(a.ext['103']!.sip, '111');
    const target = await until(() => h.ari.peerOf(consult), 2000, 'consult connected');
    expect(h.ari.legsTo(a.ext['111']!.sip).map((l) => l.id)).toContain(target);
    expect(h.ari.legsTo('+16315550132')).toHaveLength(0);
    h.ari.referAttended(agent, consult);
    await until(() => h.ari.peerOf(caller) === target, 2000, 'caller joined with 111');
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('an ordinary call between extensions (nothing on hold) still follows forward always', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '103' });
    await a.extension({ number: '111', forwardAlways: { type: 'external', number: '+16315550132' } });
    await a.number(nextDid(), null);
    h.ari.external.set('+16315550132', { answerAfterMs: 5 });
    const ph = h.ari.deviceCall(a.ext['103']!.sip, '111');
    await until(() => h.ari.legsTo('+16315550132')[0], 2000, 'forwarded to the outside number');
    expect(h.ari.legsTo(a.ext['111']!.sip)).toHaveLength(0);
    h.ari.remoteHangup(ph);
    await h.settle();
  });

  it("another account's 103 holding a call does not make this account's 103 -> 111 a consult call", async () => {
    // Live 2026-11-25 (Pereira Deli, pbx-5): 102 called 105 (forward always to an outside number)
    // with nothing on hold, but some other account's 102 held a call on the same node: "consult
    // call", forward always skipped, 105 rang. Extension numbers are only unique per account.
    const h = makeHarness(db.sql);
    const other = await new Account(db.sql).create();
    await other.extension({ number: '103' });
    const otherDid = nextDid();
    await other.number(otherDid, { type: 'extension', id: other.ext['103']!.id });
    h.ari.sip.set(other.ext['103']!.sip, { answerAfterMs: 5 });
    const otherCaller = h.ari.carrierCall(otherDid, '+16315550120');
    const otherAgent = await until(() => h.ari.peerOf(otherCaller), 3000, 'other account connected');
    h.ari.hold(otherAgent);
    await until(() => h.ari.channels.get(otherCaller)!.moh, 2000, 'other account on hold');

    const a = await new Account(db.sql).create();
    await a.extension({ number: '103' });
    await a.extension({ number: '111', forwardAlways: { type: 'external', number: '+16315550132' } });
    await a.number(nextDid(), null);
    h.ari.sip.set(a.ext['111']!.sip, { answerAfterMs: 5 });
    h.ari.external.set('+16315550132', { answerAfterMs: 5 });
    const ph = h.ari.deviceCall(a.ext['103']!.sip, '111');
    await until(() => h.ari.legsTo('+16315550132')[0], 2000, 'forwarded to the outside number');
    expect(h.ari.legsTo(a.ext['111']!.sip)).toHaveLength(0);
    h.ari.remoteHangup(ph);
    h.ari.remoteHangup(otherCaller);
    await h.settle();
  });

  // Found on the deployed system (2026-11-12, softphone): the phone answers call 1, answers call 2
  // (call waiting, which holds call 1) and transfers call 1 to call 2. Both of the phone's legs are
  // channels WE originated, and each conversation's session routes the CALLER (B / C), so the
  // consult conversation's released party is its session's primary. It used to be hung up by that
  // call flow's cleanup, which ended the joined call too.
  it('call waiting: two inbound calls answered on one phone, transfer one to the other -> callers bridged', async () => {
    const { h, a, did, caller: b, agent: a1 } = await connectedCall();
    const c = h.ari.carrierCall(did, '+16315551111');
    const a2 = await until(() => h.ari.peerOf(c), 3000, 'call 2 connected');
    expect(a2).not.toBe(a1);
    h.ari.hold(a1); // answering call 2 holds call 1
    await until(() => h.ari.channels.get(b)!.moh);
    h.ari.referAttended(a1, a2);
    await until(() => h.ari.peerOf(b) === c, 2000, 'B joined with C');
    expect(h.ari.channels.get(b)!.moh).toBe(false);
    await until(() => !h.ari.channels.has(a1) && !h.ari.channels.has(a2), 2000, 'phone legs dropped');
    expect(h.ari.transferProgressLog).toContainEqual({ channelId: a1, state: 'channel_answered' });
    // Stays up: nobody hangs up B or C on their own.
    await new Promise((r) => setTimeout(r, 50));
    expect(h.ari.channels.has(b) && h.ari.channels.has(c)).toBe(true);
    expect(h.ari.peerOf(b)).toBe(c);
    // C hangs up -> B is hung up, everything ends.
    h.ari.remoteHangup(c);
    await until(() => !h.ari.channels.has(b));
    await h.settle();
    const rows = (await a.cdrs()).filter((r) => r.direction === 'incoming');
    expect(rows).toHaveLength(2);
    const call1 = rows.find((r) => r.fromNumber === '+16315550000')!;
    const call2 = rows.find((r) => r.fromNumber === '+16315551111')!;
    expect(call1).toMatchObject({ outcome: 'answered', toExtension: '101' });
    expect(call2).toMatchObject({ outcome: 'answered', toExtension: '101' });
    // Call 2's leg lasts until C really hung up, not until the transfer.
    expect(call2.endedAt.getTime()).toBeGreaterThanOrEqual(call2.answeredAt!.getTime() + 45);
    expect(h.ctx.conversations.size).toBe(0);
    expect(h.ctx.bus.size).toBe(0);
  });

  it('call waiting, other direction: transfer call 2 to call 1 -> callers bridged', async () => {
    const { h, did, caller: b, agent: a1 } = await connectedCall();
    h.ari.hold(a1);
    const c = h.ari.carrierCall(did, '+16315551111');
    const a2 = await until(() => h.ari.peerOf(c), 3000, 'call 2 connected');
    h.ari.referAttended(a2, a1);
    await until(() => h.ari.peerOf(c) === b, 2000, 'C joined with B');
    expect(h.ari.channels.get(b)!.moh).toBe(false);
    await until(() => !h.ari.channels.has(a1) && !h.ari.channels.has(a2), 2000, 'phone legs dropped');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.ari.peerOf(c)).toBe(b);
    h.ari.remoteHangup(b);
    await until(() => !h.ari.channels.has(c));
    await h.settle();
    expect(h.ctx.conversations.size).toBe(0);
    expect(h.ctx.bus.size).toBe(0);
  });

  it('phone with an outgoing call to 102 takes an inbound call and transfers 102 to the caller', async () => {
    // Call 1: B -> 101 (session primary B). Call 2: 101 dials 102 (session primary = 101's own leg).
    // REFER on call 2 with Replaces = call 1: B (call 1's primary) moves into call 2's bridge.
    const { h, a, caller: b } = await connectedCall();
    const out = h.ari.deviceCall(a.ext['101']!.sip, '102');
    const leg102 = await until(() => h.ari.peerOf(out), 2000, '102 connected');
    const a1 = await until(() => h.ari.peerOf(b));
    h.ari.referAttended(out, a1); // REFER on the outgoing call, Replaces = the inbound call's leg
    await until(() => h.ari.peerOf(leg102) === b, 2000, '102 joined with B');
    await until(() => !h.ari.channels.has(a1) && !h.ari.channels.has(out), 2000, 'phone legs dropped');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.ari.peerOf(b)).toBe(leg102);
    h.ari.remoteHangup(leg102);
    await until(() => !h.ari.channels.has(b));
    await h.settle();
    expect(h.ctx.conversations.size).toBe(0);
    expect(h.ctx.bus.size).toBe(0);
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

// Spec §5: "CDRs per leg (direction, numbers, DID/extensions, start/answer/end, billable duration,
// outcome ...)". Live 2026-11-15 (course grader tickets, call_records): a transfer overwrote the
// main row's to_extension, so the extension that answered first was missing from call history
// ("no record of the internal call ... involving 108", "the incoming call's record lacks
// extension 102"). Now the main row keeps the first answerer and spans the whole call (billing
// unchanged); each transfer to an extension adds a free internal row (parent = main row).
describe('§5 CDRs of transferred calls', () => {
  /** The API's extension filter (services/api/src/routes/calls.ts, GET /calls?extension=). */
  async function searchExtension(a: Account, ext: string) {
    return db.sql<{ id: string; callId: string }[]>`
      select id, call_id from cdrs
       where tenant_id = ${a.id} and (from_extension = ${ext} or to_extension = ${ext})`;
  }

  it('blind transfer of an incoming call: main row = first answerer, child row = target', async () => {
    const { h, a, did, caller, agent } = await connectedCall();
    await new Promise((r) => setTimeout(r, 20));
    h.ari.referBlind(agent, '102');
    const leg102 = await until(() => h.ari.legsTo(a.ext['102']!.sip)[0], 2000, 'rings 102');
    await until(() => h.ari.peerOf(caller) === leg102.id, 2000, 'caller bridged to 102');
    await new Promise((r) => setTimeout(r, 20));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows).toHaveLength(2);
    const [main, child] = rows as [CdrRow, CdrRow];
    expect(main).toMatchObject({ parentId: null, direction: 'incoming', fromNumber: '+16315550000', toNumber: did, did, toExtension: '101', outcome: 'answered' });
    expect(child).toMatchObject({
      parentId: main.id,
      callId: main.callId,
      direction: 'internal',
      fromNumber: '+16315550000',
      fromExtension: null,
      toNumber: '102',
      toExtension: '102',
      did,
      outcome: 'answered',
      voicemail: false,
      charge: '0.000000',
      cost: '0.000000',
    });
    // The child starts at the transfer and ends with the call; the main row spans the whole call.
    expect(child.startedAt.getTime()).toBeGreaterThanOrEqual(main.answeredAt!.getTime() + 15);
    expect(child.answeredAt!.getTime()).toBeGreaterThanOrEqual(child.startedAt.getTime());
    expect(child.endedAt.getTime()).toBe(main.endedAt.getTime());
    // History search finds the call for either extension.
    expect((await searchExtension(a, '101')).map((r) => r.id)).toEqual([main.id]);
    expect((await searchExtension(a, '102')).map((r) => r.id)).toEqual([child.id]);
  });

  it('IVR -> 102 answers -> blind transfer to 108 (Zhang Animal Hospital ticket)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '102' });
    await a.extension({ number: '108' });
    const menu = await a.ivr({ options: { '2': { type: 'extension', id: a.ext['102']!.id } } });
    const did = nextDid();
    await a.number(did, { type: 'ivr_menu', id: menu });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['108']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550144');
    await until(() => h.ari.channels.get(caller)?.answered, 2000, 'IVR answered');
    h.ari.dtmf(caller, '2');
    const agent = await until(() => h.ari.peerOf(caller), 3000, '102 connected');
    h.ari.referBlind(agent, '108');
    const leg108 = await until(() => h.ari.legsTo(a.ext['108']!.sip)[0], 2000, 'rings 108');
    await until(() => h.ari.peerOf(caller) === leg108.id);
    h.ari.remoteHangup(leg108.id);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows.map((r) => [r.parentId === null, r.toExtension, r.outcome])).toEqual([
      [true, '102', 'answered'],
      [false, '108', 'answered'],
    ]);
    expect(new Set(rows.map((r) => r.callId)).size).toBe(1);
    expect(await searchExtension(a, '102')).toHaveLength(1);
    expect(await searchExtension(a, '108')).toHaveLength(1);
  });

  it("internal call 105 -> 108, 108 transfers the caller back to 105's own extension (Pioneer ticket)", async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '105' });
    await a.extension({ number: '108' });
    h.ari.sip.set(a.ext['105']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['108']!.sip, { answerAfterMs: 5 });
    const ph105 = h.ari.deviceCall(a.ext['105']!.sip, '108');
    const leg108 = await until(() => h.ari.peerOf(ph105), 2000, '108 answered');
    h.ari.referBlind(leg108, '105');
    const leg105 = await until(() => h.ari.legsTo(a.ext['105']!.sip)[0], 2000, 'rings 105');
    await until(() => h.ari.peerOf(ph105) === leg105.id);
    h.ari.remoteHangup(ph105);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ parentId: null, direction: 'internal', fromExtension: '105', toNumber: '108', toExtension: '108', outcome: 'answered' });
    expect(rows[1]).toMatchObject({ parentId: rows[0]!.id, direction: 'internal', fromExtension: '105', toExtension: '105', outcome: 'answered' });
    // GET /calls?extension=108 finds the call (it didn't before the fix).
    expect((await searchExtension(a, '108')).map((r) => r.id)).toEqual([rows[0]!.id]);
  });

  it('internal call 105 -> 108, 108 transfers the caller to 109: the record has 108 and 109 (from PR #81)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    for (const n of ['105', '108', '109']) await a.extension({ number: n });
    for (const n of ['108', '109']) h.ari.sip.set(a.ext[n]!.sip, { answerAfterMs: 5 });
    const ph105 = h.ari.deviceCall(a.ext['105']!.sip, '108');
    const leg108 = await until(() => h.ari.peerOf(ph105), 3000, '108 answered');
    h.ari.referBlind(leg108, '109');
    const leg109 = await until(() => h.ari.legsTo(a.ext['109']!.sip)[0], 2000, 'rings 109');
    await until(() => h.ari.peerOf(ph105) === leg109.id, 2000, '105 bridged to 109');
    h.ari.remoteHangup(ph105);
    await h.settle();
    const [main, leg] = await a.cdrs();
    expect(main).toMatchObject({ direction: 'internal', fromExtension: '105', toExtension: '108', outcome: 'answered', parentId: null });
    // The child row is between the parties left talking: 105 (still on the call) and 109.
    expect(leg).toMatchObject({ direction: 'internal', fromExtension: '105', toExtension: '109', outcome: 'answered', parentId: main!.id, charge: '0.000000' });
    expect((await searchExtension(a, '109')).map((r) => r.id)).toEqual([leg!.id]);
  });

  it('the caller transfers: the child row is from the party left on the call (108) to the target', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    for (const n of ['105', '108', '110']) {
      await a.extension({ number: n });
      h.ari.sip.set(a.ext[n]!.sip, { answerAfterMs: 5 });
    }
    const ph105 = h.ari.deviceCall(a.ext['105']!.sip, '108');
    const leg108 = await until(() => h.ari.peerOf(ph105), 2000, '108 answered');
    h.ari.referBlind(ph105, '110');
    const leg110 = await until(() => h.ari.legsTo(a.ext['110']!.sip)[0], 2000, 'rings 110');
    await until(() => h.ari.peerOf(leg108) === leg110.id);
    h.ari.remoteHangup(leg110.id);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows[0]).toMatchObject({ fromExtension: '105', toExtension: '108' });
    expect(rows[1]).toMatchObject({ fromExtension: '108', fromNumber: '108', toExtension: '110', outcome: 'answered' });
  });

  it('transferred twice: one child row per target, the first ends at the second transfer', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    for (const n of ['101', '102', '103']) {
      await a.extension({ number: n });
      h.ari.sip.set(a.ext[n]!.sip, { answerAfterMs: 5 });
    }
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    const caller = h.ari.carrierCall(did, '+16315550000');
    const agent = await until(() => h.ari.peerOf(caller), 3000, 'connected');
    h.ari.referBlind(agent, '102');
    const leg102 = await until(() => h.ari.legsTo(a.ext['102']!.sip)[0]);
    await until(() => h.ari.peerOf(caller) === leg102.id);
    await new Promise((r) => setTimeout(r, 20));
    h.ari.referBlind(leg102.id, '103');
    const leg103 = await until(() => h.ari.legsTo(a.ext['103']!.sip)[0]);
    await until(() => h.ari.peerOf(caller) === leg103.id);
    await new Promise((r) => setTimeout(r, 20));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows.map((r) => r.toExtension)).toEqual(['101', '102', '103']);
    const [main, to102, to103] = rows as [CdrRow, CdrRow, CdrRow];
    expect(to102.parentId).toBe(main.id);
    expect(to103.parentId).toBe(main.id);
    expect(to102.endedAt.getTime()).toBeLessThanOrEqual(to103.startedAt.getTime());
    expect(to103.endedAt.getTime()).toBe(main.endedAt.getTime());
  });

  it('target does not answer -> its row is no_answer + voicemail; the main row stays answered', async () => {
    const { h, a, caller, agent } = await connectedCall();
    h.ari.sip.set(a.ext['102']!.sip, { failCause: 20 });
    h.ari.referBlind(agent, '102');
    await until(() => h.uploads.begun.find((u) => u.mailboxId === a.ext['102']!.mailboxId));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows[0]).toMatchObject({ toExtension: '101', outcome: 'answered' });
    expect(rows[1]).toMatchObject({ toExtension: '102', outcome: 'no_answer', voicemail: true, answeredAt: null, billableSec: 0 });
  });

  it('attended transfer: the incoming call gets a child row for the target; the consult call keeps its own', async () => {
    const { h, a, caller, agent } = await connectedCall();
    h.ari.hold(agent);
    await until(() => h.ari.channels.get(caller)!.moh);
    const consult = h.ari.deviceCall(a.ext['101']!.sip, '102');
    const target = await until(() => h.ari.peerOf(consult), 2000, 'consult connected');
    h.ari.referAttended(agent, consult);
    await until(() => h.ari.peerOf(caller) === target);
    await new Promise((r) => setTimeout(r, 20));
    h.ari.remoteHangup(caller);
    await h.settle();
    const rows = await a.cdrs();
    const main = rows.find((r) => r.direction === 'incoming')!;
    const child = rows.find((r) => r.parentId === main.id)!;
    const consultRow = rows.find((r) => r.callId !== main.callId)!;
    expect(rows).toHaveLength(3);
    expect(main).toMatchObject({ toExtension: '101', outcome: 'answered' });
    expect(child).toMatchObject({ direction: 'internal', fromNumber: '+16315550000', toExtension: '102', outcome: 'answered', charge: '0.000000' });
    expect(child.answeredAt!.getTime()).toBe(child.startedAt.getTime()); // 102 was already on the line
    expect(child.endedAt.getTime()).toBe(main.endedAt.getTime());
    expect(consultRow).toMatchObject({ direction: 'internal', fromExtension: '101', toExtension: '102', outcome: 'answered' });
    // The consult call ends at the transfer, the joined call later.
    expect(consultRow.endedAt.getTime()).toBeLessThanOrEqual(child.startedAt.getTime() + 5);
  });

  it('call waiting attended transfer between two callers: no extension child row', async () => {
    const { h, a, did, caller: b, agent: a1 } = await connectedCall();
    const c = h.ari.carrierCall(did, '+16315551111');
    const a2 = await until(() => h.ari.peerOf(c), 3000, 'call 2 connected');
    h.ari.hold(a1);
    h.ari.referAttended(a1, a2);
    await until(() => h.ari.peerOf(b) === c);
    h.ari.remoteHangup(c);
    await h.settle();
    const rows = await a.cdrs();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.parentId === null && r.toExtension === '101')).toBe(true);
  });

  it('toll-free incoming call transferred: charged once, on the main row, for the whole call', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    await a.extension({ number: '102' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id }, 'toll_free', 0.025);
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    const agent = await until(() => h.ari.peerOf(caller), 3000);
    h.ari.referBlind(agent, '102');
    const leg102 = await until(() => h.ari.legsTo(a.ext['102']!.sip)[0]);
    await until(() => h.ari.peerOf(caller) === leg102.id);
    h.ari.remoteHangup(caller);
    await h.settle();
    const [main, child] = (await a.cdrs()) as [CdrRow, CdrRow];
    expect(main).toMatchObject({ billableSec: 30, toExtension: '101' });
    const [p] = await db.sql<{ tollFreeInPerMin: string }[]>`select toll_free_in_per_min from call_pricing limit 1`;
    expect(Number(main.charge)).toBeCloseTo((30 * Number(p!.tollFreeInPerMin)) / 60, 6);
    expect(Number(main.cost)).toBeGreaterThan(0);
    expect(child).toMatchObject({ toExtension: '102', charge: '0.000000', cost: '0.000000', includedSec: 0 });
    const [sum] = await db.sql<{ charge: string }[]>`select sum(charge) as charge from cdrs where call_id = ${main.callId}`;
    expect(Number(sum!.charge)).toBeCloseTo(Number(main.charge), 6);
  });

  it('outgoing call the phone transfers to 102: vendor leg billed once, 102 on a free child row', async () => {
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
    const [main, child] = (await a.cdrs()) as [CdrRow, CdrRow];
    expect(main).toMatchObject({ direction: 'outgoing', fromExtension: '101', toNumber: '+12015550123', toExtension: null, vendor: 'us' });
    expect(child).toMatchObject({ direction: 'internal', fromNumber: '+12015550123', fromExtension: null, toExtension: '102', vendor: null, charge: '0.000000', includedSec: 0 });
  });
});
