import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, startDb, until, type Db, type Harness } from '../harness/env.js';

// Observability (2026-11-15): every log line of a call carries the SIP Call-ID (the id the edges'
// captures and rtpengine records use), and "call ended" carries the call's whole route trace,
// so a failure the course reports can be followed end to end. src/trace.ts.

let db: Db;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db?.close());

type Line = Record<string, unknown> & { msg?: string; trace?: { steps: { msg: string; [k: string]: unknown }[] } };
const ended = (h: Harness, ch: string) => h.logs.find((l) => l.msg === 'call ended' && l.ch === ch) as Line | undefined;

describe('call trace', () => {
  it('every line of a call carries its SIP Call-ID; "call ended" has the route trace', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e = await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: e });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000', 'abc123@130.245.136.142');
    await until(() => h.ari.peerOf(caller), 2000, 'answered');
    h.ari.remoteHangup(caller);
    await h.settle();

    const lines = h.logs.filter((l) => l.ch === caller);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.sip).toBe('abc123@130.245.136.142');

    const end = ended(h, caller)!;
    expect(end).toMatchObject({ outcome: 'answered', tenant: a.id });
    const msgs = end.trace!.steps.map((st) => st.msg);
    expect(msgs).toEqual(expect.arrayContaining(['route', 'ring: answered']));
    const route = end.trace!.steps.find((st) => st.msg === 'route')!;
    expect(route).toMatchObject({ l: 0, to: { type: 'extension', id: e } });
    expect(route.t).toBeGreaterThanOrEqual(0);
    // Steps are in the order they happened.
    expect(msgs.indexOf('route')).toBeLessThan(msgs.indexOf('ring: answered'));
    // Bindings aren't repeated inside every step.
    expect(end.trace!.steps.every((st) => !('sip' in st) && !('tenant' in st))).toBe(true);
  });

  it('business hours log the local time and zone the decision used', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create({ timezone: 'America/New_York' });
    const mb = await a.mailbox('main');
    const bh = await a.businessHours([], { type: 'hangup' }, { type: 'voicemail', id: mb }); // never open
    const did = nextDid();
    await a.number(did, { type: 'business_hours', id: bh });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.uploads.begun.find((u) => u.kind === 'voicemail'), 3000, 'voicemail');
    h.ari.remoteHangup(caller);
    await h.settle();
    const step = ended(h, caller)!.trace!.steps.find((st) => st.msg === 'business hours')!;
    expect(step).toMatchObject({ open: false, tz: 'America/New_York' });
    expect(step.local).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/); // e.g. "Sun 04:19"
    expect(ended(h, caller)!.trace!.steps.map((st) => st.msg)).toContain('voicemail: recording');
  });

  it('a dialplan without the Call-ID argument (older Asterisk config) still works, without `sip`', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e = await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: e });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000', null);
    await until(() => h.ari.peerOf(caller), 2000, 'answered');
    h.ari.remoteHangup(caller);
    await h.settle();
    const end = ended(h, caller)!;
    expect(end.outcome).toBe('answered');
    expect('sip' in end).toBe(false);
  });

  it('a Call-ID containing a comma survives the Stasis argument split', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e = await a.extension({ number: '101' });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: e });
    h.ari.sip.set(a.ext['101']!.sip, { answerAfterMs: 5 });
    const caller = h.ari.carrierCall(did, '+16315550000', 'odd,id@host');
    await until(() => h.ari.peerOf(caller), 2000, 'answered');
    h.ari.remoteHangup(caller);
    await h.settle();
    expect(ended(h, caller)!.sip).toBe('odd,id@host');
  });
});
