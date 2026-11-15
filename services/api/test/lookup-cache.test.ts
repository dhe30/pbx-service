import { describe, expect, it, vi } from 'vitest';
import { LookupCache } from '../src/numbers/lookup-cache.js';

// The DID provider's reference-list cache (src/numbers/lookup-cache.ts): one load per key,
// stale-while-revalidate after the TTL, failures never cached, bounded size.

function setup(opts: { maxEntries?: number } = {}) {
  let now = 0;
  const onRefreshError = vi.fn();
  const cache = new LookupCache<string>({ ttlMs: 1000, maxEntries: opts.maxEntries ?? 10, now: () => now, onRefreshError });
  return { cache, onRefreshError, advance: (ms: number) => (now += ms) };
}

/** A load the test settles by hand. */
function deferred() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('LookupCache', () => {
  it('loads a key once and serves it from memory until the TTL', async () => {
    const { cache, advance } = setup();
    const load = vi.fn(async () => 'v1');
    expect(await cache.get('k', load)).toBe('v1');
    advance(999);
    expect(await cache.get('k', load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shares one load between concurrent callers', async () => {
    const { cache } = setup();
    const d = deferred();
    const load = vi.fn(() => d.promise);
    const a = cache.get('k', load);
    const b = cache.get('k', load);
    d.resolve('v1');
    expect(await Promise.all([a, b])).toEqual(['v1', 'v1']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('after the TTL answers at once with the old value and refreshes once in the background', async () => {
    const { cache, advance } = setup();
    await cache.get('k', async () => 'v1');
    advance(1000);
    const d = deferred();
    const load = vi.fn(() => d.promise);
    // Nobody waits on the provider: the stale value comes back while the refresh is pending.
    expect(await cache.get('k', load)).toBe('v1');
    expect(await cache.get('k', load)).toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);
    d.resolve('v2');
    await flush();
    expect(await cache.get('k', load)).toBe('v2');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed first load: it rejects and the next call tries again', async () => {
    const { cache } = setup();
    await expect(cache.get('k', async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
    expect(cache.size).toBe(0);
    expect(await cache.get('k', async () => 'v1')).toBe('v1');
  });

  it('keeps serving the old value when a refresh fails, without an unhandled rejection', async () => {
    const { cache, advance, onRefreshError } = setup();
    await cache.get('k', async () => 'v1');
    advance(1000);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(await cache.get('k', async () => Promise.reject(new Error('down')))).toBe('v1');
      await flush();
      expect(onRefreshError).toHaveBeenCalledWith('k', expect.objectContaining({ message: 'down' }));
      expect(unhandled).not.toHaveBeenCalled();
      // Still stale, so the next request tries the provider again (and gets the new value later).
      const load = vi.fn(async () => 'v2');
      expect(await cache.get('k', load)).toBe('v1');
      await flush();
      expect(load).toHaveBeenCalledTimes(1);
      expect(await cache.get('k', load)).toBe('v2');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('survives a load that throws synchronously', async () => {
    const { cache } = setup();
    const load = (() => {
      throw new Error('sync');
    }) as unknown as () => Promise<string>;
    await expect(cache.get('k', load)).rejects.toThrow('sync');
    expect(await cache.get('k', async () => 'v1')).toBe('v1');
  });

  it('holds at most maxEntries keys, dropping the oldest', async () => {
    const { cache } = setup({ maxEntries: 2 });
    await cache.get('a', async () => 'A');
    await cache.get('b', async () => 'B');
    await cache.get('c', async () => 'C');
    expect(cache.size).toBe(2);
    const reload = vi.fn(async () => 'A2');
    expect(await cache.get('a', reload)).toBe('A2'); // 'a' was dropped, so it loads again
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
