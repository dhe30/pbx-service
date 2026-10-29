import { describe, expect, it } from 'vitest';
import { EventBus, onChannel, onChannels } from '../src/ari/events.js';
import type { AriEvent } from '../src/ari/types.js';
import { didCandidates } from '../src/did.js';
import { CallerHold } from '../src/hold.js';
import { log } from '../src/log.js';
import { metrics } from '../src/metrics.js';
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

describe('EventBus', () => {
  it('buffers events that arrive before next() is awaited', async () => {
    const bus = new EventBus();
    const sub = bus.subscribe(onChannel('a', 'ChannelDtmfReceived'));
    bus.dispatch(dtmf('a', '1'));
    bus.dispatch(dtmf('b', '9')); // other channel: ignored
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

  it('live channel sets see ids added after subscribing', async () => {
    const bus = new EventBus();
    const ids = new Set<string>();
    const sub = bus.subscribe(onChannels(ids, 'ChannelDestroyed'));
    expect(bus.dispatch(destroyed('x'))).toBe(false);
    ids.add('x');
    expect(bus.dispatch(destroyed('x'))).toBe(true);
    expect((await sub.next())?.channel.id).toBe('x');
    sub.close();
    expect(bus.dispatch(destroyed('x'))).toBe(false);
  });
});

describe('CallerHold', () => {
  const fakeAri = (failing = false) => {
    const calls: string[] = [];
    return {
      calls,
      startMoh: async (ch: string, cls: string) => {
        calls.push(`start ${ch} ${cls}`);
        if (failing) throw new Error('ARI down');
      },
      stopMoh: async (ch: string) => {
        calls.push(`stop ${ch}`);
        if (failing) throw new Error('ARI down');
      },
    };
  };
  const quiet = log.child({}, { level: 'silent' });
  const gauge = async () => (await metrics.callsOnHold.get()).values[0]?.value ?? 0;

  it('plays MOH to the caller on hold and stops it on resume, ignoring repeats', async () => {
    const ari = fakeAri();
    const h = new CallerHold(ari, 'caller', 'default', quiet);
    const before = await gauge();
    await h.set(true);
    await h.set(true); // duplicate ChannelHold
    expect(h.isHeld).toBe(true);
    expect(await gauge()).toBe(before + 1);
    await h.set(false);
    await h.set(true);
    await h.set(false);
    expect(ari.calls).toEqual(['start caller default', 'stop caller', 'start caller default', 'stop caller']);
    expect(await gauge()).toBe(before);
  });

  it('never throws when ARI fails, and end() resets the gauge', async () => {
    const h = new CallerHold(fakeAri(true), 'caller', 'default', quiet);
    const before = await gauge();
    await expect(h.set(true)).resolves.toBeUndefined();
    expect(await gauge()).toBe(before + 1);
    h.end();
    h.end();
    expect(h.isHeld).toBe(false);
    expect(await gauge()).toBe(before);
  });
});
