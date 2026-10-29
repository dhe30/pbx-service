import type { AriEvent } from './types.js';

// Event fan-out for call flows written as straight-line async code.
//
// A Subscription buffers matching events from the moment it is created, so a flow can't miss an
// event that arrives between two awaits (e.g. two ringing legs failing at the same instant, or a
// DTMF digit pressed right as a prompt ends). Always create the subscription BEFORE the action
// that triggers the event, and close() it when done (use try/finally).

export class Subscription<E extends AriEvent> {
  private queue: E[] = [];
  private waiter: ((e: E | null) => void) | null = null;
  private closed = false;

  constructor(
    private readonly bus: EventBus,
    readonly match: (e: AriEvent) => e is E,
  ) {}

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
    this.bus.remove(this);
    this.waiter?.(null);
  }
}

export class EventBus {
  private subs = new Set<Subscription<AriEvent>>();

  subscribe<E extends AriEvent>(match: (e: AriEvent) => e is E): Subscription<E> {
    const sub = new Subscription<E>(this, match);
    this.subs.add(sub as unknown as Subscription<AriEvent>);
    return sub;
  }

  /** Wait once for a matching event (subscribe + next + close). */
  async once<E extends AriEvent>(
    match: (e: AriEvent) => e is E,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<E | null> {
    const sub = this.subscribe(match);
    try {
      return await sub.next(opts);
    } finally {
      sub.close();
    }
  }

  /** Deliver an event to every matching subscription. Returns true if anyone took it. */
  dispatch(e: AriEvent): boolean {
    let matched = false;
    for (const sub of this.subs) {
      if (sub.match(e)) {
        sub.push(e);
        matched = true;
      }
    }
    return matched;
  }

  /** @internal */
  remove(sub: object): void {
    this.subs.delete(sub as Subscription<AriEvent>);
  }
}

// ---- Matchers ------------------------------------------------------------------------------

export const isType =
  <T extends AriEvent['type']>(type: T) =>
  (e: AriEvent): e is Extract<AriEvent, { type: T }> =>
    e.type === type;

/** Any event about `channelId` of the given type(s). */
export function onChannel<T extends AriEvent['type']>(channelId: string, ...types: T[]) {
  return (e: AriEvent): e is Extract<AriEvent, { type: T }> =>
    (types as string[]).includes(e.type) && 'channel' in e && e.channel.id === channelId;
}

/** Any event about one of `channelIds` (a live Set; mutations are seen). */
export function onChannels<T extends AriEvent['type']>(channelIds: Set<string>, ...types: T[]) {
  return (e: AriEvent): e is Extract<AriEvent, { type: T }> =>
    (types as string[]).includes(e.type) && 'channel' in e && channelIds.has(e.channel.id);
}

export function onPlaybackFinished(playbackId: string) {
  return (e: AriEvent): e is Extract<AriEvent, { type: 'PlaybackFinished' }> =>
    e.type === 'PlaybackFinished' && e.playback.id === playbackId;
}

export function onRecordingDone(name: string) {
  return (e: AriEvent): e is Extract<AriEvent, { type: 'RecordingFinished' | 'RecordingFailed' }> =>
    (e.type === 'RecordingFinished' || e.type === 'RecordingFailed') && e.recording.name === name;
}
