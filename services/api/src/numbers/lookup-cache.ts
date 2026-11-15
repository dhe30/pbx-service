// In-memory cache for the DID provider's reference lists (countries, regions, cities).
//
// Why (2026-11-15, loadtest/diag/haproxy-slow.py + Prometheus): these three routes called DIDWW
// on every request, and 25 of the API's 35 requests over 1 s in a day were them, each ~1.05 s
// (a fresh connection to the course service losing its first SYN). The lists barely change.
//
// Behaviour:
//  - A miss loads once; concurrent callers for the same key share that one load.
//  - After `ttlMs` the cached value is still returned at once, and ONE background load refreshes
//    it (stale-while-revalidate), so after the first request no customer waits on DIDWW again.
//  - Failures are never cached: a failed first load rejects (the route answers 502 as before) and
//    the next request tries again; a failed refresh keeps serving the old value.
//  - At most `maxEntries` keys (oldest dropped first): keys include request parameters.
// Per API process; each app node warms its own copy.

export interface LookupCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** Called when a background refresh fails (the stale value keeps being served). */
  onRefreshError?: (key: string, err: unknown) => void;
  now?: () => number;
}

interface Entry<V> {
  /** Set once a load has succeeded. */
  loaded: { value: V; at: number } | null;
  /** The load in progress, if any. */
  pending: Promise<V> | null;
}

export class LookupCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly now: () => number;

  constructor(private readonly o: LookupCacheOptions) {
    this.now = o.now ?? Date.now;
  }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const entry = this.entries.get(key);
    if (entry?.loaded) {
      if (!entry.pending && this.now() - entry.loaded.at >= this.o.ttlMs) {
        // Background refresh: nobody awaits it, so its failure must not become an unhandled
        // rejection (index.ts exits on those).
        this.load(key, entry, load).catch((err: unknown) => this.o.onRefreshError?.(key, err));
      }
      return Promise.resolve(entry.loaded.value);
    }
    if (entry?.pending) return entry.pending;
    const fresh: Entry<V> = { loaded: null, pending: null };
    this.insert(key, fresh);
    return this.load(key, fresh, load);
  }

  get size(): number {
    return this.entries.size;
  }

  private load(key: string, entry: Entry<V>, load: () => Promise<V>): Promise<V> {
    const p = (async () => {
      // Yield first, so `entry.pending = p` below is set before this can settle (even if load()
      // throws synchronously).
      await null;
      try {
        const value = await load();
        entry.loaded = { value, at: this.now() };
        return value;
      } catch (err) {
        // Never cache a failure. Keep a previous value (stale beats an error for these lists).
        if (!entry.loaded && this.entries.get(key) === entry) this.entries.delete(key);
        throw err;
      } finally {
        entry.pending = null;
      }
    })();
    entry.pending = p;
    return p;
  }

  private insert(key: string, entry: Entry<V>): void {
    while (this.entries.size >= this.o.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }
}
