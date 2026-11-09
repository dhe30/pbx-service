import type { AriEvent } from './types.js';

// Event fan-out for call flows written as straight-line async code.
//
// A Subscription buffers matching events from the moment it is created, so a flow can't miss an
// event that arrives between two awaits (e.g. two ringing legs failing at the same instant, or a
// DTMF digit pressed right as a prompt ends). Always create the subscription BEFORE the action
// that triggers the event, and close() it when done (use try/finally).
//
// Performance (bottleneck B7): subscriptions are INDEXED by key (channel id, playback id,
// recording name). An event is only offered to the subscriptions registered under its keys, so
// dispatch cost is O(subscriptions for that call), not O(all subscriptions on the node). The
// phase-1 bus tested every subscription against every event: O(n^2) in concurrent calls.

export type Key = string;
export const chKey = (channelId: string): Key => `ch:${channelId}`;
export const pbKey = (playbackId: string): Key => `pb:${playbackId}`;
export const recKey = (name: string): Key => `rec:${name}`;

/** The index keys an event is delivered under. */
export function eventKeys(e: AriEvent): Key[] {
  switch (e.type) {
    case 'PlaybackFinished': {
      const keys = [pbKey(e.playback.id)];
      if (e.playback.target_uri?.startsWith('channel:')) keys.push(chKey(e.playback.target_uri.slice(8)));
      return keys;
    }
    case 'RecordingFinished':
    case 'RecordingFailed':
      return [recKey(e.recording.name)];
    case 'ChannelTransfer':
      return [chKey(e.referred_by.source_channel.id)];
    default:
      return 'channel' in e ? [chKey(e.channel.id)] : [];
  }
}

export interface Matcher<E extends AriEvent> {
  match: (e: AriEvent) => e is E;
  /** Index keys to register under. */
  keys: Key[];
}

export class Subscription<E extends AriEvent> {
  private queue: E[] = [];
  private waiter: ((e: E | null) => void) | null = null;
  private closed = false;
  readonly keys = new Set<Key>();

  constructor(
    private readonly bus: EventBus,
    readonly match: (e: AriEvent) => e is E,
  ) {}

  /** Also receive events under `key` (e.g. a channel originated after subscribing). */
  watch(key: Key): void {
    if (this.closed || this.keys.has(key)) return;
    this.keys.add(key);
    this.bus.index(this as unknown as Subscription<AriEvent>, key);
  }

  unwatch(key: Key): void {
    if (!this.keys.delete(key)) return;
    this.bus.unindex(this as unknown as Subscription<AriEvent>, key);
  }

  /** @internal called by EventBus */
  push(e: E): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(e);
    } else {
      this.queue.push(e);
    }
  }

  /**
   * Next matching event, or null on timeout. Rejects with `signal.reason` if the signal aborts
   * (e.g. the caller hung up).
   */
  next(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<E | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    const { timeoutMs, signal } = opts;
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise<E | null>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const cleanup = () => {
        this.waiter = null;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiter = (e) => {
        cleanup();
        resolve(e);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, Math.max(0, timeoutMs));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const k of this.keys) this.bus.unindex(this as unknown as Subscription<AriEvent>, k);
    this.keys.clear();
    this.waiter?.(null);
  }
}

export class EventBus {
  private readonly byKey = new Map<Key, Set<Subscription<AriEvent>>>();

  subscribe<E extends AriEvent>(m: Matcher<E>): Subscription<E> {
    const sub = new Subscription<E>(this, m.match);
    for (const k of m.keys) sub.watch(k);
    return sub;
  }

  /** Wait once for a matching event (subscribe + next + close). */
  async once<E extends AriEvent>(m: Matcher<E>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<E | null> {
    const sub = this.subscribe(m);
    try {
      return await sub.next(opts);
    } finally {
      sub.close();
    }
  }

  /** Deliver an event to every matching subscription. Returns true if anyone took it. */
  dispatch(e: AriEvent): boolean {
    let matched = false;
    const seen = new Set<Subscription<AriEvent>>();
    for (const k of eventKeys(e)) {
      const subs = this.byKey.get(k);
      if (!subs) continue;
      for (const sub of [...subs]) {
        if (seen.has(sub)) continue;
        seen.add(sub);
        if (sub.match(e)) {
          sub.push(e);
          matched = true;
        }
      }
    }
    return matched;
  }

  /** Number of index entries (for tests/metrics: must return to 0 when calls end). */
  get size(): number {
    let n = 0;
    for (const s of this.byKey.values()) n += s.size;
    return n;
  }

  /** @internal */
  index(sub: Subscription<AriEvent>, key: Key): void {
    let set = this.byKey.get(key);
    if (!set) this.byKey.set(key, (set = new Set()));
    set.add(sub);
  }

  /** @internal */
  unindex(sub: Subscription<AriEvent>, key: Key): void {
    const set = this.byKey.get(key);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.byKey.delete(key);
  }
}

// ---- Matchers ------------------------------------------------------------------------------

type Of<T extends AriEvent['type']> = Extract<AriEvent, { type: T }>;

/** Events of the given type(s) about `channelId`. */
export function onChannel<T extends AriEvent['type']>(channelId: string, ...types: T[]): Matcher<Of<T>> {
  return {
    keys: [chKey(channelId)],
    match: (e): e is Of<T> =>
      (types as string[]).includes(e.type) &&
      (('channel' in e && e.channel.id === channelId) ||
        (e.type === 'ChannelTransfer' && e.referred_by.source_channel.id === channelId) ||
        (e.type === 'PlaybackFinished' && e.playback.target_uri === `channel:${channelId}`)),
  };
}

/** Events of the given type(s) about any channel the subscription watches (add ids with watch()). */
export function onWatched<T extends AriEvent['type']>(...types: T[]): Matcher<Of<T>> {
  return { keys: [], match: (e): e is Of<T> => (types as string[]).includes(e.type) };
}

export function onPlaybackFinished(playbackId: string): Matcher<Of<'PlaybackFinished'>> {
  return { keys: [pbKey(playbackId)], match: (e): e is Of<'PlaybackFinished'> => e.type === 'PlaybackFinished' && e.playback.id === playbackId };
}

export function onRecordingDone(name: string): Matcher<Of<'RecordingFinished' | 'RecordingFailed'>> {
  return {
    keys: [recKey(name)],
    match: (e): e is Of<'RecordingFinished' | 'RecordingFailed'> =>
      (e.type === 'RecordingFinished' || e.type === 'RecordingFailed') && e.recording.name === name,
  };
}
