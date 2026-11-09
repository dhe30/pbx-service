import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, startDb, until, type Db, type Harness } from '../harness/env.js';

// Course spec §3: IVR menus, ring groups, business hours, number routing, caller blocklist.

let db: Db;
beforeAll(async () => {
  db = await startDb();
  await db.sql`insert into rate_decks (vendor, prefix, destination, per_min) values ('us', '1', 'US', 0.01)`;
});
afterAll(async () => db?.close());

async function acct() {
  const h = makeHarness(db.sql);
  const a = await new Account(db.sql).create();
  return { h, a };
}

/** Wait until the caller is bridged with someone; returns the peer channel id. */
const bridged = (h: Harness, caller: string) => until(() => h.ari.peerOf(caller), 3000, 'bridged');
const playsTo = (h: Harness, ch: string) => h.ari.plays.filter((p) => p.channelId === ch).map((p) => p.media);

describe('§3 Number routing: each number routes to an extension, ring group, IVR menu, or business-hours schedule', () => {
  it('number -> ring group', async () => {
    const { h, a } = await acct();
    await a.extension({ number: '101' });
    await a.extension({ number: '102' });
    const g = await a.ringGroup('all', ['101', '102'], 20, null);
    const did = nextDid();
    await a.number(did, { type: 'ring_group', id: g });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    expect(await bridged(h, caller)).toBe(h.ari.legsTo(a.ext['102']!.sip)[0]!.id);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('number -> IVR menu answers and plays the customer greeting', async () => {
    const { h, a } = await acct();
    const menu = await a.ivr({ options: {} });
    await db.sql`update ivr_menus set greeting_media_id = null where id = ${menu}`;
    const did = nextDid();
    await a.number(did, { type: 'ivr_menu', id: menu });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.channels.get(caller)?.answered, 2000, 'answered');
    await until(() => playsTo(h, caller).includes('sound:hello-world'));
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('a phase-1 number with only ivr_menu_id still routes to its menu', async () => {
    const { h, a } = await acct();
    const menu = await a.ivr({ options: {} });
    const did = nextDid();
    await a.number(did, null);
    await db.sql`update phone_numbers set ivr_menu_id = ${menu} where did = ${did}`;
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length > 0);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('unknown DID -> 404 (unallocated)', async () => {
    const h = makeHarness(db.sql);
    const caller = h.ari.carrierCall('+19995550000', '+16315550000');
    await until(() => h.ari.destroyed.has(caller));
    expect(h.ari.hangups.find((x) => x.channelId === caller)?.reason).toBe('unallocated');
    await h.settle();
  });

  it('PDD: 180 Ringing is sent before anything else happens', async () => {
    const { h, a } = await acct();
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.originates.length > 0);
    expect(h.ari.channels.get(caller)!.rung).toBe(true);
    expect(h.ari.channels.get(caller)!.answered).toBe(false); // not answered until someone picks up
    h.ari.remoteHangup(caller);
    await h.settle();
  });
});

describe('§3 IVR menus: digits route to an extension, ring group, menu, voicemail box, or external number; timeout, invalid-input action, repeat', () => {
  async function menuSetup(config: Record<string, unknown>, opts: { timeoutSec?: number; maxRetries?: number } = {}) {
    const { h, a } = await acct();
    await a.extension({ number: '101' });
    const mb = await a.mailbox('Main');
    const sub = await a.ivr({ options: { '1': { type: 'extension', id: a.ext['101']!.id } } });
    const cfg = JSON.parse(JSON.stringify(config).replaceAll('$EXT', a.ext['101']!.id).replaceAll('$MB', mb).replaceAll('$SUB', sub));
    const menu = await a.ivr(cfg, opts);
    const did = nextDid();
    await a.number(did, { type: 'ivr_menu', id: menu });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    return { h, a, did, mb, sub };
  }

  it('digit -> extension', async () => {
    const { h, did } = await menuSetup({ options: { '1': { type: 'extension', id: '$EXT' } } });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.plays.some((p) => p.channelId === caller));
    h.ari.dtmf(caller, '1');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('digit -> another menu (nested), then digit -> extension', async () => {
    const { h, did } = await menuSetup({ options: { '9': { type: 'ivr_menu', id: '$SUB' } } });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length === 1);
    h.ari.dtmf(caller, '9');
    await until(() => playsTo(h, caller).length >= 2, 2000, 'sub-menu prompt');
    h.ari.dtmf(caller, '1');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('digit -> voicemail box', async () => {
    const { h, did, mb } = await menuSetup({ options: { '2': { type: 'voicemail', id: '$MB' } } });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length > 0);
    h.ari.dtmf(caller, '2');
    await until(() => h.uploads.begun.find((u) => u.kind === 'voicemail' && u.mailboxId === mb));
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('digit -> external number (charged leg)', async () => {
    const { h, a, did } = await menuSetup({ options: { '3': { type: 'external', number: '+12015556666' } } });
    h.ari.external.set('+12015556666', { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length > 0);
    h.ari.dtmf(caller, '3');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[1]).toMatchObject({ direction: 'outgoing', toNumber: '+12015556666', vendor: 'us' });
  });

  it('no input: replays up to max_retries, then the timeout destination', async () => {
    const { h, did, mb } = await menuSetup({ options: {}, timeout: { type: 'voicemail', id: '$MB' } }, { timeoutSec: 2, maxRetries: 3 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.mailboxId === mb), 3000, 'timeout -> voicemail');
    expect(playsTo(h, caller).filter((m) => m === 'sound:hello-world')).toHaveLength(3);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('invalid digit with an invalid-input destination goes there immediately', async () => {
    const { h, did } = await menuSetup({ options: {}, invalid: { type: 'extension', id: '$EXT' } });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length > 0);
    h.ari.dtmf(caller, '7');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('invalid digit without one: "invalid option" prompt and the menu is replayed', async () => {
    const { h, did } = await menuSetup({ options: { '1': { type: 'extension', id: '$EXT' } } });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length > 0);
    h.ari.dtmf(caller, '7');
    await until(() => playsTo(h, caller).includes('sound:option-is-invalid'));
    await until(() => playsTo(h, caller).filter((m) => m === 'sound:hello-world').length === 2, 2000, 'menu replayed');
    h.ari.dtmf(caller, '1');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('repeat digit (default *) replays the menu without using up a retry', async () => {
    const { h, did } = await menuSetup({ options: { '1': { type: 'extension', id: '$EXT' } } }, { maxRetries: 1 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => playsTo(h, caller).length === 1);
    h.ari.dtmf(caller, '*');
    await until(() => playsTo(h, caller).length === 2, 2000, 'replayed');
    h.ari.dtmf(caller, '*');
    await until(() => playsTo(h, caller).length === 3, 2000, 'replayed again');
    h.ari.dtmf(caller, '1');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('phase-1 config format ({action, target} + on_timeout) still works', async () => {
    const { h, did, mb } = await menuSetup({ options: {}, on_timeout: { action: 'voicemail', target: '$MB' } }, { timeoutSec: 1, maxRetries: 1 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.mailboxId === mb));
    h.ari.remoteHangup(caller);
    await h.settle();
  });
});

describe('§3 Ring groups: extensions rung all at once or in order (each for a set time); timeout and no-answer destination', () => {
  it('all at once: every member rings simultaneously', async () => {
    const { h, a } = await acct();
    for (const n of ['101', '102', '103']) await a.extension({ number: n });
    const g = await a.ringGroup('all', ['101', '102', '103'], 20, null);
    const did = nextDid();
    await a.number(did, { type: 'ring_group', id: g });
    h.ari.sip.set(a.ext['103']!.sip, { answerAfterMs: 30 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.originates.length === 3, 2000, 'all three ringing');
    await bridged(h, caller);
    // The other two stop.
    const others = h.ari.originates.filter((o) => o.target.kind === 'sip' && o.target.user !== a.ext['103']!.sip);
    await until(() => others.every((o) => h.ari.destroyed.has(o.channelId)));
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('in order: one member at a time, each for ring_timeout_sec', async () => {
    const { h, a } = await acct();
    for (const n of ['101', '102']) await a.extension({ number: n });
    const g = await a.ringGroup('sequential', ['101', '102'], 5, null);
    const did = nextDid();
    await a.number(did, { type: 'ring_group', id: g });
    h.ari.sip.set(a.ext['102']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.originates.length === 1);
    expect(h.ari.originates[0]!.target).toMatchObject({ user: a.ext['101']!.sip });
    const t0 = Date.now();
    await until(() => h.ari.originates.length === 2, 2000, 'second member');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35); // ~5 s scaled
    expect(h.ari.destroyed.has(h.ari.originates[0]!.channelId)).toBe(true);
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('nobody answers within the timeout -> no-answer destination', async () => {
    const { h, a } = await acct();
    await a.extension({ number: '101' });
    const mb = await a.mailbox('Group VM');
    const g = await a.ringGroup('all', ['101'], 5, { type: 'voicemail', id: mb });
    const did = nextDid();
    await a.number(did, { type: 'ring_group', id: g });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.mailboxId === mb), 3000, 'group voicemail');
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'no_answer', voicemail: true });
  });

  it('members ring their listed external numbers too', async () => {
    const { h, a } = await acct();
    await a.extension({ number: '101', externalNumbers: ['+12015554444'] });
    const g = await a.ringGroup('all', ['101'], 5, null);
    const did = nextDid();
    await a.number(did, { type: 'ring_group', id: g });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.originates.length === 2);
    h.ari.remoteHangup(caller);
    await h.settle();
  });
});

describe('§3 Business hours: weekly schedule in the account time zone; open and closed destinations', () => {
  async function bh(intervals: { day: number; start: string; end: string }[], timezone: string) {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create({ timezone });
    await a.extension({ number: '101' });
    const closedMb = await a.mailbox('Closed');
    const id = await a.businessHours(intervals, { type: 'extension', id: a.ext['101']!.id }, { type: 'voicemail', id: closedMb });
    const did = nextDid();
    await a.number(did, { type: 'business_hours', id });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    return { h, did, closedMb };
  }

  it('open (24/7 schedule) -> open destination', async () => {
    const all = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));
    const { h, did } = await bh(all, 'America/New_York');
    const caller = h.ari.carrierCall(did, '+16315550000');
    await bridged(h, caller);
    h.ari.remoteHangup(caller);
    await h.settle();
  });

  it('closed (empty schedule) -> closed destination', async () => {
    const { h, did, closedMb } = await bh([], 'America/New_York');
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.mailboxId === closedMb));
    h.ari.remoteHangup(caller);
    await h.settle();
  });
});

describe('§3 Caller blocklist: listed callers are rejected', () => {
  it('rejected with 403 before ringing anyone, CDR outcome blocked', async () => {
    const { h, a } = await acct();
    await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: a.ext['101']!.id });
    await a.block('+16315550666');
    // The carrier sends the caller as digits without '+': normalized before matching.
    const caller = h.ari.carrierCall(did, '16315550666');
    await until(() => h.ari.destroyed.has(caller));
    expect(h.ari.hangups.find((x) => x.channelId === caller)?.reason).toBe('rejected');
    expect(h.ari.originates).toHaveLength(0);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'blocked', direction: 'incoming', fromNumber: '+16315550666' });
  });
});
