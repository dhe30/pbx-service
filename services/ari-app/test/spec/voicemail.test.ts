import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account, makeHarness, nextDid, sleep, startDb, until, type Db, type Harness } from '../harness/env.js';

// Course spec §3 "Voicemail": "Callers hear the greeting and leave a message. Play and delete
// messages on the web or by dialing *98, which uses Cisco Unity Connection's standard conversation:
// main menu 1 new messages, 3 1 saved messages; during playback 1 restart, 2 save, 3 delete,
// ## next (unchanged); after playback 1 replay, 2 save, 3 delete, # next (unchanged). Changes show
// in both places."
// §6: "serve voicemail and recordings as WAV (16-bit PCM mono, 8 kHz)".

let db: Db;
beforeAll(async () => {
  db = await startDb();
});
afterAll(async () => db?.close());

describe('§3 Voicemail: leaving a message', () => {
  it('plays the mailbox greeting (customer upload), then records with a beep; # ends it', async () => {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    const e = await a.extension({ number: '101' });
    const mb = a.ext['101']!.mailboxId!;
    const greeting = '11111111-1111-4111-8111-111111111111';
    await db.sql`insert into media (id, tenant_id, kind, object_key, format) values (${greeting}, ${a.id}, 'greeting', 'g', 'wav')`;
    await db.sql`update mailboxes set greeting_media_id = ${greeting} where id = ${mb}`;
    await db.sql`update extensions set ring_timeout_sec = 5 where id = ${e}`;
    const did = nextDid();
    await a.number(did, { type: 'extension', id: e });
    const caller = h.ari.carrierCall(did, '+16315550000');
    const up = await until(() => h.uploads.begun.find((u) => u.kind === 'voicemail'), 3000, 'recording');
    expect(h.ari.plays.filter((p) => p.channelId === caller).map((p) => p.media)).toContain(`sound:/cache/${greeting}`);
    expect(up).toMatchObject({ tenantId: a.id, mailboxId: mb, callerNumber: '+16315550000' });
    h.ari.remoteHangup(caller);
    await h.settle();
    expect(h.uploads.finished).toContain(up.name);
  });

  it('records as wav (Asterisk "wav" = 16-bit signed linear PCM, 8 kHz, mono)', async () => {
    const { AriClient } = await import('../../src/ari/client.js');
    const calls: { body?: string; url: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), body: init.body as string });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const c = new AriClient({ url: 'http://127.0.0.1:8088', user: 'u', password: 'p', app: 'pbx-app' });
      await c.recordChannel('ch', { name: 'vm-x', maxDurationSeconds: 120, maxSilenceSeconds: 5, beep: true, terminateOn: '#' });
      await c.recordBridge('br', 'rec-x');
    } finally {
      globalThis.fetch = realFetch;
    }
    for (const c of calls) expect(new URL(c.url).searchParams.get('format')).toBe('wav');
    expect(new URL(calls[0]!.url).searchParams.get('terminateOn')).toBe('#');
  });
});

describe('§3 *98: Cisco Unity standard conversation', () => {
  async function mailbox() {
    const h = makeHarness(db.sql);
    const a = await new Account(db.sql).create();
    await a.extension({ number: '101' });
    const mb = a.ext['101']!.mailboxId!;
    const t0 = Date.now() - 60_000;
    const m1 = await a.voicemail(mb, false, new Date(t0));
    const m2 = await a.voicemail(mb, false, new Date(t0 + 1000));
    const s1 = await a.voicemail(mb, true, new Date(t0 + 2000));
    const call = () => h.ari.deviceCall(a.ext['101']!.sip, '*98');
    return { h, a, mb, m1, m2, s1, call };
  }
  const heard = async (id: string) => (await db.sql<{ heard: boolean }[]>`select heard from voicemails where id = ${id}`)[0]?.heard ?? 'deleted';
  /** Wait until the caller hears `media` for the `n`th time. */
  const heardPrompt = (h: Harness, ch: string, media: string, n = 1) =>
    until(() => h.ari.plays.filter((p) => p.channelId === ch && p.media === media).length >= n, 3000, `${media} x${n}`);
  const msgPlays = (h: Harness, ch: string) => h.ari.plays.filter((p) => p.channelId === ch && p.media.startsWith('sound:/cache/')).map((p) => p.media);

  it('main menu says how many new messages; 1 plays NEW messages oldest first', async () => {
    const { h, call } = await mailbox();
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    expect(h.ari.plays.filter((p) => p.channelId === ch).map((p) => p.media)).toContain('number:2');
    h.ari.dtmf(ch, '1');
    await until(() => msgPlays(h, ch).length === 1);
    h.ari.remoteHangup(ch);
    await h.settle();
    expect(h.ari.channels.has(ch)).toBe(false);
  });

  it('during playback: 2 saves (new -> saved) and moves to the next message', async () => {
    const { h, m1, m2, call } = await mailbox();
    h.ari.playMs = 40; // messages take a while to play, so keys arrive DURING playback
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '1');
    await until(() => msgPlays(h, ch).length === 1);
    h.ari.dtmf(ch, '2');
    await until(async () => (await heard(m1)) === true, 2000, 'm1 saved');
    await heardPrompt(h, ch, 'sound:vm-msgsaved');
    await until(() => msgPlays(h, ch).length === 2, 2000, 'next message');
    expect(await heard(m2)).toBe(false);
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('during playback: 3 deletes (gone from the web inbox too)', async () => {
    const { h, m1, call } = await mailbox();
    h.ari.playMs = 40;
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '1');
    await until(() => msgPlays(h, ch).length === 1);
    h.ari.dtmf(ch, '3');
    await until(async () => (await heard(m1)) === 'deleted', 2000, 'deleted');
    await heardPrompt(h, ch, 'sound:vm-deleted');
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('during playback: 1 restarts the message', async () => {
    const { h, call } = await mailbox();
    h.ari.playMs = 40;
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '1');
    await until(() => msgPlays(h, ch).length === 1);
    h.ari.dtmf(ch, '1');
    await until(() => msgPlays(h, ch).length === 2, 2000, 'restarted');
    expect(msgPlays(h, ch)[0]).toBe(msgPlays(h, ch)[1]);
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('during playback: ## skips to the next message, leaving it NEW (unchanged)', async () => {
    const { h, m1, call } = await mailbox();
    h.ari.playMs = 40;
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '1');
    await until(() => msgPlays(h, ch).length === 1);
    h.ari.dtmf(ch, '##');
    await until(() => msgPlays(h, ch).length === 2, 2000, 'next message');
    expect(msgPlays(h, ch)[0]).not.toBe(msgPlays(h, ch)[1]);
    expect(await heard(m1)).toBe(false);
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('after playback: 1 replay, 2 save, 3 delete, # next unchanged', async () => {
    const { h, m1, m2, call } = await mailbox();
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '1');
    // m1 plays to the end -> after-playback menu
    await heardPrompt(h, ch, 'sound:beep');
    h.ari.dtmf(ch, '1'); // replay
    await until(() => msgPlays(h, ch).length === 2);
    await heardPrompt(h, ch, 'sound:beep', 2);
    h.ari.dtmf(ch, '#'); // next, m1 unchanged
    await until(() => msgPlays(h, ch).length === 3);
    expect(await heard(m1)).toBe(false);
    await heardPrompt(h, ch, 'sound:beep', 3);
    h.ari.dtmf(ch, '2'); // save m2
    await until(async () => (await heard(m2)) === true);
    // End of the list -> "no more messages", back at the main menu.
    await heardPrompt(h, ch, 'sound:vm-nomore');
    await heardPrompt(h, ch, 'sound:vm-onefor', 2);
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('after playback: 3 deletes', async () => {
    const { h, m1, call } = await mailbox();
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '1');
    await heardPrompt(h, ch, 'sound:beep');
    h.ari.dtmf(ch, '3');
    await until(async () => (await heard(m1)) === 'deleted');
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('main menu 3 then 1 plays SAVED messages', async () => {
    const { h, s1, call } = await mailbox();
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    h.ari.dtmf(ch, '31');
    const media = await until(() => msgPlays(h, ch)[0]);
    const [row] = await db.sql<{ mediaId: string }[]>`select media_id from voicemails where id = ${s1}`;
    expect(media).toBe(`sound:/cache/${row!.mediaId}`);
    h.ari.remoteHangup(ch);
    await h.settle();
  });

  it('a change on the web (row deleted / marked heard) shows up on the next *98 call', async () => {
    const { h, a, mb, m1, call } = await mailbox();
    await db.sql`delete from voicemails where id = ${m1}`; // DELETE /voicemails/:id on the web
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    expect(h.ari.plays.filter((p) => p.channelId === ch).map((p) => p.media)).toContain('number:1');
    h.ari.remoteHangup(ch);
    await h.settle();
    const c = await h.ctx.repo.countVoicemails(a.id, mb);
    expect(c).toEqual({ new: 1, saved: 1 });
  });

  it('*98 itself is an internal CDR (free)', async () => {
    const { h, a, call } = await mailbox();
    const ch = call();
    await heardPrompt(h, ch, 'sound:vm-onefor');
    await sleep(5);
    h.ari.remoteHangup(ch);
    await h.settle();
    const [row] = await a.cdrs();
    expect(row).toMatchObject({ direction: 'internal', toNumber: '*98', outcome: 'answered', charge: '0.000000', fromExtension: '101' });
    // Answered by the PBX itself: the answer time is set like any answered call's.
    expect(row!.answeredAt).not.toBeNull();
    expect(row!.endedAt.getTime()).toBeGreaterThanOrEqual(row!.answeredAt!.getTime());
  });
});
