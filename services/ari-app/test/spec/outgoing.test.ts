import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, startDb, until, type Db } from '../harness/env.js';

// Course spec §3 "Outgoing calls": "Accept US numbers as 10 digits or 1 + 10 digits, and any number
// as E.164 (+) or with 011. Route by destination; present one of the account's numbers as caller ID."
// §1 "US vendor: US numbers. International vendor: everything else, including non-US +1 countries."
// §2 "International calling. Without it, calls outside the US (including other +1 countries) are blocked."
// §5 "Unpaid 24 hours after period end: past due, outgoing calls blocked ... unblock within one minute of payment."

let db: Db;
beforeAll(async () => {
  db = await startDb();
  await db.sql`insert into rate_decks (vendor, prefix, destination, per_min) values
    ('us', '1', 'United States', 0.01), ('us', '1201', 'US New Jersey', 0.009),
    ('intl', '44', 'United Kingdom', 0.02), ('intl', '447', 'United Kingdom Mobile', 0.05),
    ('intl', '1416', 'Canada Toronto', 0.015)`;
});
afterAll(async () => db?.close());

async function phone(opts: Parameters<Account['create']>[0] = {}, callerId?: string) {
  const h = makeHarness(db.sql);
  const a = await new Account(db.sql).create(opts);
  const did1 = nextDid();
  const did2 = nextDid();
  await a.number(did1, null);
  await a.number(did2, null);
  await a.extension({ number: '101', callerId: callerId === 'second' ? did2 : callerId });
  return { h, a, sip: a.ext['101']!.sip, did1, did2 };
}

async function dial(h: ReturnType<typeof makeHarness>, sip: string, dialed: string) {
  const ch = h.ari.deviceCall(sip, dialed);
  await until(() => h.ari.originates.length > 0 || h.ari.destroyed.has(ch), 2000, `dial ${dialed}`);
  return ch;
}

describe('§3 Outgoing calls: accepted number formats', () => {
  for (const [dialed, e164] of [
    ['2015550123', '+12015550123'], // 10 digits
    ['12015550123', '+12015550123'], // 1 + 10 digits
    ['+12015550123', '+12015550123'], // E.164
    ['(201) 555-0123', '+12015550123'], // visual separators from a phone's dial pad / softphone
    ['011442071234567', '+442071234567'], // 011 international prefix
    ['+442071234567', '+442071234567'],
  ] as const) {
    it(`"${dialed}" -> ${e164}`, async () => {
      const { h, sip } = await phone({ intlCalling: true });
      const ch = await dial(h, sip, dialed);
      expect(h.ari.originates[0]!.target).toMatchObject({ kind: 'external', number: e164 });
      h.ari.remoteHangup(ch);
      await h.settle();
    });
  }

  it('something that is neither an extension nor a number -> 404, CDR failed', async () => {
    const { h, a, sip } = await phone();
    const ch = h.ari.deviceCall(sip, '12345');
    await until(() => h.ari.destroyed.has(ch));
    expect(h.ari.hangups.find((x) => x.channelId === ch)?.reason).toBe('unallocated');
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ direction: 'outgoing', outcome: 'failed' });
  });
});

describe('§1 Route by destination', () => {
  it('US number -> US vendor', async () => {
    const { h, a, sip } = await phone();
    h.ari.external.set('+12015550123', { answerAfterMs: 5 });
    const ch = await dial(h, sip, '2015550123');
    expect(h.ari.originates[0]!.endpoint).toBe('PJSIP/vendor-us-edge-a/sip:+12015550123@us-vendor.cse356.compas.cs.stonybrook.edu');
    await until(() => h.ari.peerOf(ch));
    h.ari.remoteHangup(ch);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ direction: 'outgoing', vendor: 'us', ratePrefix: '1201', outcome: 'answered', fromExtension: '101' });
  });

  it('other countries -> international vendor (longest prefix rates the call)', async () => {
    const { h, a, sip } = await phone({ intlCalling: true });
    h.ari.external.set('+447700900123', { answerAfterMs: 5 });
    const ch = await dial(h, sip, '+447700900123');
    expect(h.ari.originates[0]!.endpoint).toMatch(/^PJSIP\/vendor-intl-edge-a\/sip:\+447700900123@intl-vendor\./);
    await until(() => h.ari.peerOf(ch));
    h.ari.remoteHangup(ch);
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ vendor: 'intl', ratePrefix: '447' });
  });

  it('non-US +1 country (Canada, Jamaica) -> international vendor', async () => {
    const { h, sip } = await phone({ intlCalling: true });
    const ch = await dial(h, sip, '4165550123');
    expect(h.ari.originates[0]!.target).toMatchObject({ vendor: 'intl', number: '+14165550123' });
    h.ari.remoteHangup(ch);
    await h.settle();
    const h2 = makeHarness(db.sql);
    const ch2 = h2.ari.deviceCall(sip, '18765550123');
    await until(() => h2.ari.originates.length > 0);
    expect(h2.ari.originates[0]!.target).toMatchObject({ vendor: 'intl' });
    h2.ari.remoteHangup(ch2);
    await h2.settle();
  });

  it('vendor number format is configurable (e164_noplus)', async () => {
    const { a, sip } = await phone();
    const h = makeHarness(db.sql, { VENDOR_NUMBER_FORMAT: 'e164_noplus' });
    void a;
    const ch = await dial(h, sip, '2015550123');
    expect(h.ari.originates[0]!.endpoint).toBe('PJSIP/vendor-us-edge-a/sip:12015550123@us-vendor.cse356.compas.cs.stonybrook.edu');
    h.ari.remoteHangup(ch);
    await h.settle();
  });
});

describe('§3 Caller ID: one of the account’s numbers', () => {
  it('the extension’s configured caller ID when it is the account’s', async () => {
    const { h, sip, did2 } = await phone({}, 'second');
    const ch = await dial(h, sip, '2015550123');
    expect(h.ari.originates[0]!.callerId).toBe(did2);
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('otherwise the account’s first number (never a number it doesn’t own)', async () => {
    const { h, sip, did1 } = await phone({}, '+19998887777');
    const ch = await dial(h, sip, '2015550123');
    expect(h.ari.originates[0]!.callerId).toBe(did1);
    h.ari.remoteHangup(ch);
    await h.settle();
  });
});

describe('§2 / §5 Blocked outgoing calls', () => {
  it('international without the add-on: 403, CDR blocked, no vendor leg', async () => {
    const { h, a, sip } = await phone({ intlCalling: false });
    const ch = h.ari.deviceCall(sip, '+442071234567');
    await until(() => h.ari.destroyed.has(ch));
    expect(h.ari.originates).toHaveLength(0);
    expect(h.ari.hangups.find((x) => x.channelId === ch)?.reason).toBe('rejected');
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'blocked', toNumber: '+442071234567', charge: '0.000000' });
  });

  it('Canada counts as international for the add-on', async () => {
    const { h, sip } = await phone({ intlCalling: false });
    const ch = h.ari.deviceCall(sip, '4165550123');
    await until(() => h.ari.destroyed.has(ch));
    expect(h.ari.originates).toHaveLength(0);
    await h.settle();
  });

  it('past due: outgoing blocked; incoming and internal calls still work', async () => {
    const { h, a, sip } = await phone({ status: 'past_due' });
    const ch = h.ari.deviceCall(sip, '2015550123');
    await until(() => h.ari.destroyed.has(ch));
    expect(h.ari.originates).toHaveLength(0);
    await a.extension({ number: '102' });
    h.ctx.cache.invalidateTenant(a.id); // what NOTIFY pbx_config does on every pbx node
    const internal = h.ari.deviceCall(sip, '102');
    await until(() => h.ari.originates.length === 1, 2000, 'internal call still rings');
    h.ari.remoteHangup(internal);
    await h.settle();
    expect((await a.cdrs()).map((r) => r.outcome)).toContain('blocked');
  });

  it('past due also blocks forwarding / simultaneous ring to external numbers (they are outgoing legs)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create({ status: 'past_due' });
    const e = await a.extension({ number: '101', externalNumbers: ['+12015557777'] });
    const did = nextDid();
    await a.number(did, { type: 'extension', id: e });
    const caller = h.ari.carrierCall(did, '+16315550000');
    await until(() => h.ari.originates.length === 1);
    expect(h.ari.originates[0]!.target.kind).toBe('sip');
    h.ari.remoteHangup(caller);
    await h.settle();
    expect((await a.cdrs())[1]).toMatchObject({ outcome: 'blocked', toNumber: '+12015557777' });
  });

  it('paying unblocks: the status change invalidates the cached account (well within 1 minute)', async () => {
    const { h, a, sip } = await phone({ status: 'past_due' });
    const ch1 = h.ari.deviceCall(sip, '2015550123');
    await until(() => h.ari.destroyed.has(ch1));
    expect(h.ari.originates).toHaveLength(0);
    await db.sql`update tenants set status = 'active' where id = ${a.id}`;
    // In production every pbx node receives NOTIFY pbx_config '<tenant>' from the trigger; the
    // ConfigCache handler drops the snapshot. (Here: the same handler, called directly.)
    h.ctx.cache.invalidateTenant(a.id);
    const ch2 = await dial(h, sip, '2015550123');
    expect(h.ari.originates).toHaveLength(1);
    h.ari.remoteHangup(ch2);
    await h.settle();
  });

  it('even without the NOTIFY, a cached account is never older than CONFIG_TTL_SEC (< 60 s)', async () => {
    const { h, a, sip } = await phone({ status: 'past_due' });
    const ch1 = h.ari.deviceCall(sip, '2015550123');
    await until(() => h.ari.destroyed.has(ch1));
    await db.sql`update tenants set status = 'active' where id = ${a.id}`;
    expect(h.ctx.cfg.CONFIG_TTL_SEC).toBeLessThan(60);
    const snap = await h.ctx.cache.tenant(a.id);
    snap!.loadedAt = 0; // not used for freshness; age the cache entry instead:
    (h.ctx.cache as unknown as { tenants: Map<string, { at: number }> }).tenants.get(a.id)!.at -= (h.ctx.cfg.CONFIG_TTL_SEC + 1) * 1000;
    const ch2 = await dial(h, sip, '2015550123');
    expect(h.ari.originates).toHaveLength(1);
    h.ari.remoteHangup(ch2);
    await h.settle();
  });
});

describe('§1 Vendor failures', () => {
  it('vendor busy -> 486 back to the phone, CDR busy', async () => {
    const { h, a, sip } = await phone();
    h.ari.external.set('+12015550123', { failCause: 17, failAfterMs: 5 });
    const ch = h.ari.deviceCall(sip, '2015550123');
    await until(() => h.ari.destroyed.has(ch));
    expect(h.ari.hangups.find((x) => x.channelId === ch)?.reason).toBe('busy');
    await h.settle();
    expect((await a.cdrs())[0]).toMatchObject({ outcome: 'busy', billableSec: 0 });
  });

  it('vendor out of funds (402) / server error -> failed', async () => {
    const { h, a, sip } = await phone();
    h.ari.external.set('+12015550123', { failCause: 38, failAfterMs: 5000 });
    h.ari.external.set('+12015550124', { failCause: 38, failAfterMs: 5 });
    const ch = h.ari.deviceCall(sip, '2015550124');
    await until(() => h.ari.destroyed.has(ch), 3000);
    await h.settle();
    expect((await a.cdrs())[0]!.outcome).toBe('failed');
  });

  it('no account number to present as caller ID -> the call fails (never an unowned caller ID)', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    const ch = h.ari.deviceCall(a.ext['101']!.sip, '2015550123');
    await until(() => h.ari.destroyed.has(ch));
    expect(h.ari.originates).toHaveLength(0);
    await h.settle();
  });
});
