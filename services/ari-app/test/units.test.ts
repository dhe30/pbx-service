import { describe, expect, it, vi } from 'vitest';
import { AriClient, AriError } from '../src/ari/client.js';
import { ConfigCache } from '../src/cache.js';
import { EventBus, chKey, onChannel, onPlaybackFinished, onWatched } from '../src/ari/events.js';
import type { AriEvent, ChannelTransfer } from '../src/ari/types.js';
import { referTarget } from '../src/conversation.js';
import { didCandidates } from '../src/did.js';
import { combineOutcomes, outcomeFromCause } from '../src/session.js';
import { wavDurationMs } from '../src/wav.js';

const chan = (id: string) => ({
  id,
  name: `PJSIP/x-${id}`,
  state: 'Up',
  caller: { name: '', number: '' },
  connected: { name: '', number: '' },
  dialplan: { context: 'from-edge', exten: 's', priority: 1 },
});
const dtmf = (id: string, digit: string): AriEvent => ({
  type: 'ChannelDtmfReceived',
  application: 'pbx-app',
  timestamp: '',
  digit,
  duration_ms: 100,
  channel: chan(id),
});
const destroyed = (id: string): AriEvent => ({
  type: 'ChannelDestroyed',
  application: 'pbx-app',
  timestamp: '',
  cause: 16,
  cause_txt: 'Normal Clearing',
  channel: chan(id),
});

describe('didCandidates', () => {
  it('normalizes to E.164 with +', () => {
    expect(didCandidates('15555550100')).toEqual(['+15555550100']);
    expect(didCandidates('+15555550100')).toEqual(['+15555550100']);
  });
  it('rejects non-numbers', () => {
    expect(didCandidates('s')).toEqual([]);
    expect(didCandidates('alice')).toEqual([]);
    expect(didCandidates('0123')).toEqual([]);
  });
});

describe('wavDurationMs', () => {
  it('computes 8 kHz 16-bit mono duration', () => {
    expect(wavDurationMs(44 + 16000)).toBe(1000);
    expect(wavDurationMs(10)).toBe(0);
  });
});

describe('EventBus (indexed, B7)', () => {
  it('buffers events that arrive before next() is awaited', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(onChannel('a', 'ChannelDtmfReceived'));
    bus.dispatch(dtmf('a', '1'));
    bus.dispatch(dtmf('b', '9')); // other channel: not even offered to this subscription
    bus.dispatch(dtmf('a', '2'));
    expect((await sub.next())?.digit).toBe('1');
    expect((await sub.next())?.digit).toBe('2');
    sub.close();
  });

  it('returns null on timeout and rejects on abort', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(onChannel('a', 'ChannelDtmfReceived'));
    expect(await sub.next({ timeoutMs: 5 })).toBeNull();
    const ac = new AbortController();
    const p = sub.next({ signal: ac.signal });
    ac.abort(new Error('hangup'));
    await expect(p).rejects.toThrow('hangup');
    sub.close();
  });

  it('watch() adds channels after subscribing; close() removes every index entry', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(onWatched('ChannelDestroyed'));
    expect(bus.dispatch(destroyed('x'))).toBe(false);
    sub.watch(chKey('x'));
    expect(bus.dispatch(destroyed('x'))).toBe(true);
    expect((await sub.next())?.channel.id).toBe('x');
    sub.close();
    expect(bus.dispatch(destroyed('x'))).toBe(false);
    expect(bus.size).toBe(0);
  });

  it('dispatch cost does not grow with unrelated calls', () => {
    const bus = new EventBus();
    let tested = 0;
    for (let i = 0; i < 5000; i++) {
      bus.subscribe({ keys: [chKey(`other-${i}`)], match: (e): e is AriEvent => (tested++, e.type === 'ChannelDestroyed') });
    }
    const mine = bus.subscribe(onChannel('mine', 'ChannelDestroyed'));
    bus.dispatch(destroyed('mine'));
    expect(tested).toBe(0); // the 5000 other calls' subscriptions were never consulted
    mine.close();
  });

  it('routes PlaybackFinished by playback id and by target channel', () => {
    const bus = new EventBus();
    const byId = bus.subscribe(onPlaybackFinished('pb1'));
    const byCh = bus.subscribe(onChannel('c1', 'PlaybackFinished'));
    const ev: AriEvent = { type: 'PlaybackFinished', application: '', timestamp: '', playback: { id: 'pb1', media_uri: '', target_uri: 'channel:c1', state: 'done' } };
    expect(bus.dispatch(ev)).toBe(true);
    expect(byId).toBeTruthy();
    byId.close();
    byCh.close();
  });
});

describe('outcomes (spec §5: answered, busy, no answer, failed, blocked)', () => {
  it('maps Q.850 causes', () => {
    expect(outcomeFromCause(17)).toBe('busy'); // 486
    expect(outcomeFromCause(21)).toBe('busy'); // 603 decline
    expect(outcomeFromCause(19)).toBe('no_answer');
    expect(outcomeFromCause(20)).toBe('no_answer'); // 480 not registered
    expect(outcomeFromCause(16)).toBe('no_answer'); // cancelled
    expect(outcomeFromCause(38)).toBe('failed');
    expect(outcomeFromCause(34)).toBe('failed');
    expect(outcomeFromCause(1)).toBe('failed'); // 404
  });
  it('combines several legs', () => {
    expect(combineOutcomes(['busy', 'busy'], false)).toBe('busy');
    expect(combineOutcomes(['busy', 'no_answer'], false)).toBe('no_answer');
    expect(combineOutcomes(['failed'], false)).toBe('failed');
    expect(combineOutcomes(['busy'], true)).toBe('no_answer');
  });
});

describe('referTarget', () => {
  const ev = (destination: string): ChannelTransfer => ({
    type: 'ChannelTransfer',
    application: '',
    timestamp: '',
    refer_to: { requested_destination: { destination } },
    referred_by: { source_channel: chan('a') },
  });
  it('takes the user part of the Refer-To URI', () => {
    expect(referTarget(ev('sip:102@group-4.cse356.compas.cs.stonybrook.edu'))).toBe('102');
    expect(referTarget(ev('<sip:+12015550123@x;user=phone>'))).toBe('+12015550123');
    expect(referTarget(ev('sip:%2B442071234567@x'))).toBe('+442071234567');
    expect(referTarget(ev('2015550123'))).toBe('2015550123');
    expect(referTarget(ev(''))).toBeNull();
  });
});

describe('AriClient.stopPlayback', () => {
  const client = () => new AriClient({ url: 'http://127.0.0.1:1', user: 'u', password: 'p', app: 'pbx-app' });
  const failWith = (c: AriClient, status: number, body: string) =>
    vi.spyOn(c, 'request').mockRejectedValue(new AriError(status, 'DELETE', '/playbacks/x', body));

  it('ignores a playback that is already gone (404) or just finishing (500 "Could not stop playback")', async () => {
    const a = client();
    failWith(a, 404, '{"message":"Playback not found"}');
    await expect(a.stopPlayback('x')).resolves.toBeUndefined();
    const b = client();
    failWith(b, 500, '{"message":"Could not stop playback"}');
    await expect(b.stopPlayback('x')).resolves.toBeUndefined();
  });

  it('still throws on other errors', async () => {
    const c = client();
    failWith(c, 500, '{"message":"Internal error"}');
    await expect(c.stopPlayback('x')).rejects.toThrow(/500/);
  });
});

describe('ConfigCache background refresh (calls never wait for the DB)', () => {
  type Deferred = { resolve: (v: unknown) => void; promise: Promise<unknown> };
  const defer = (): Deferred => {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => (resolve = r));
    return { resolve, promise };
  };
  const quietLog = { debug() {}, info() {}, warn() {}, error() {} } as unknown as ConstructorParameters<typeof ConfigCache>[2];
  const setup = () => {
    let version = 0;
    const repo = {
      loadTenant: vi.fn(async (id: string) => ({ id, version: ++version })),
      tenantIdForSipUser: vi.fn(async () => 't1'),
      tenantIdForDid: vi.fn(async () => 't1'),
      loadRates: vi.fn(async () => ({})),
    };
    const cache = new ConfigCache(repo as unknown as ConstructorParameters<typeof ConfigCache>[0], 30, quietLog);
    return { repo, cache };
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('reloads an active account before the TTL, so the next call is a cache hit', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    try {
      const { repo, cache } = setup();
      await cache.tenant('t1');
      expect(repo.loadTenant).toHaveBeenCalledTimes(1);
      vi.setSystemTime(20_000); // past TTL/2 (15 s)
      cache.refreshNow();
      await flush();
      expect(repo.loadTenant).toHaveBeenCalledTimes(2);
      vi.setSystemTime(40_000); // 40 s after the first load: without the refresh this would reload
      const t = (await cache.tenant('t1')) as unknown as { version: number };
      expect(repo.loadTenant).toHaveBeenCalledTimes(2);
      expect(t.version).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops accounts without a call for 10 minutes instead of refreshing them', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    try {
      const { repo, cache } = setup();
      await cache.tenant('t1');
      vi.setSystemTime(11 * 60_000);
      cache.refreshNow();
      await flush();
      expect(repo.loadTenant).toHaveBeenCalledTimes(1);
      await cache.tenant('t1'); // reloaded on demand
      expect(repo.loadTenant).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a change (NOTIFY) during a background reload is not hidden by the older result', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    try {
      const { repo, cache } = setup();
      await cache.tenant('t1');
      const slow = defer();
      repo.loadTenant.mockImplementationOnce(() => slow.promise as never);
      vi.setSystemTime(20_000);
      cache.refreshNow(); // reload starts with the old data...
      cache.invalidateTenant('t1'); // ...the account changes meanwhile
      slow.resolve({ id: 't1', version: 99 });
      await flush();
      const t = (await cache.tenant('t1')) as unknown as { version: number };
      expect(t.version).not.toBe(99); // loaded again after the change, not the stale result
      expect(repo.loadTenant).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps SIP user -> account lookups for 10 minutes (dropped at once by NOTIFY)', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['Date'] });
    try {
      const { repo, cache } = setup();
      await cache.tenantForSipUser('u1');
      vi.setSystemTime(5 * 60_000);
      await cache.tenantForSipUser('u1');
      expect(repo.tenantIdForSipUser).toHaveBeenCalledTimes(1);
      cache.invalidateTenant('t1');
      await cache.tenantForSipUser('u1');
      expect(repo.tenantIdForSipUser).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
