import { NOTIFY_CONFIG_CHANNEL, NOTIFY_RATES_CHANNEL, type Sql } from '@pbx/shared';
import type { Logger } from './log.js';
import { metrics } from './metrics.js';
import type { Repo } from './repo.js';
import type { Rates, TenantConfig } from './tenant.js';

// Per-node cache of account config and rate tables (bottleneck B6).
//
// Phase 1 ran 2-4 SQL queries per call BEFORE answering (DID lookup, calls insert, ring group,
// members), each through HAProxy to the Patroni primary: that is post-dial delay, and during a
// failover every call waited on withRetry. Now a call reads an in-memory snapshot; Postgres is hit
// only on a miss.
//
// Freshness: triggers NOTIFY pbx_config '<tenant id>' on any change to that account's routing
// tables (and on tenants/tenant_settings, i.e. past-due and add-ons). Every pbx node LISTENs and
// drops the snapshot. CONFIG_TTL_SEC bounds staleness if a notification is lost (LISTEN
// connection dropped during a DB failover): the spec requires unblocking within 1 minute of
// payment, so the TTL must stay well under 60 s.
//
// Background refresh (startRefresh): an expired snapshot used to be reloaded by the next call,
// which waited for it. Measured 2026-11-14: ~150 ms before "180 Ringing" when the previous call of
// the account was > 30 s earlier (9 queries, often on freshly reopened pool connections), i.e. on
// almost every call of a small business. Now every TTL/2 the snapshots of accounts that had a call
// in the last REFRESH_IDLE_MS are reloaded in the background, so calls find a fresh one. Same
// freshness bound (never older than the TTL), no DB round trip on the call path.
//
// Slow DB (2026-11-25, docs/incidents/2026-11-25-db-commit-stalls.md): the primary's disk stalled
// and queries took 20-80 s instead of failing. A call that found no fresh snapshot (TTL passed,
// NOTIFY after an API change, LISTEN reconnect) waited for the reload the whole time, so every pbx
// node held new calls at once and Kamailio got 408s. Now an expired or invalidated snapshot is KEPT
// as a fallback (marked expired, not deleted): a call waits for the reload at most staleWaitMs and
// then uses the previous snapshot; the reload keeps running and stores its result for later calls.
// The same applies to DID / SIP user -> account ids and the rate decks. Trade-off: while the DB is
// that slow, a change made in the last seconds may not apply yet; without a previous snapshot (new
// account, first call on this node) the call still waits, as before.

interface Entry<T> {
  value: T;
  at: number;
  /** Last time a call used it (tenant snapshots): idle accounts are not refreshed. */
  usedAt?: number;
}

/** Accounts without a call for this long are dropped instead of refreshed. */
const REFRESH_IDLE_MS = 10 * 60_000;
/**
 * DID / SIP user -> account id. A SIP username or a DID never moves to another account while it
 * exists, and NOTIFY pbx_config expires these entries on any change of the account, so they can
 * live much longer than the config snapshot.
 */
const ID_TTL_MS = 10 * 60_000;

/** A call waits at most this long for a reload when a previous value exists (see top). */
const DEFAULT_STALE_WAIT_MS = 500;
/** "Using a stale value" is logged at most this often per kind (a slow DB hits every call). */
const STALE_LOG_EVERY_MS = 5000;

const TIMED_OUT = Symbol('timed out');
/** `at` of an entry that must be reloaded before its next normal use (kept as a fallback). */
const EXPIRED = Number.NEGATIVE_INFINITY;

/** `p`, or TIMED_OUT if it hasn't settled within `ms` (p keeps running). */
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return Promise.resolve(TIMED_OUT);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

interface Loading<T> {
  promise: Promise<T>;
  since: number;
}

/** Start a load; its rejection is always handled, since a caller may stop waiting for it. */
function startLoad<T>(promise: Promise<T>): Loading<T> {
  promise.catch(() => {});
  return { promise, since: Date.now() };
}

export class ConfigCache {
  /** Account snapshots; an expired or invalidated one stays (expired) as the slow-DB fallback. */
  private readonly tenants = new Map<string, Entry<TenantConfig>>();
  private readonly loading = new Map<string, Loading<TenantConfig | null>>();
  /** DID / SIP user -> tenant id (null = unknown, cached briefly). */
  private readonly didToTenant = new Map<string, Entry<string | null>>();
  private readonly sipToTenant = new Map<string, Entry<string | null>>();
  private readonly idLoading = new Map<string, Loading<string | null>>();
  private rates: Entry<Rates> | null = null;
  private ratesLoading: Loading<Rates> | null = null;
  private readonly ttlMs: number;
  private readonly negativeTtlMs = 5000;
  private readonly staleWaitMs: number;
  private readonly lastStaleLog = new Map<string, number>();
  /**
   * Bumped by every invalidation (per account) and by clear() (all): a reload that started before
   * the bump must not store its result, or a change committed meanwhile would be hidden for a TTL.
   */
  private readonly gen = new Map<string, number>();
  private epoch = 0;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: Repo,
    ttlSec: number,
    private readonly log: Logger,
    staleWaitMs = DEFAULT_STALE_WAIT_MS,
  ) {
    this.ttlMs = ttlSec * 1000;
    this.staleWaitMs = staleWaitMs;
  }

  /** Subscribe to invalidations. Safe to call once at startup; reconnects are handled by postgres.js. */
  async listen(sql: Sql): Promise<void> {
    await sql.listen(
      NOTIFY_CONFIG_CHANNEL,
      (tenantId) => this.invalidateTenant(tenantId),
      // (Re)connected: anything could have changed while we weren't listening.
      () => this.clear(),
    );
    await sql.listen(NOTIFY_RATES_CHANNEL, () => {
      if (this.rates) this.rates.at = EXPIRED;
    });
  }

  invalidateTenant(tenantId: string): void {
    this.gen.set(tenantId, (this.gen.get(tenantId) ?? 0) + 1);
    const e = this.tenants.get(tenantId);
    if (e) e.at = EXPIRED; // reload on the next call, keep it as the slow-DB fallback
    this.loading.delete(tenantId);
    for (const map of [this.didToTenant, this.sipToTenant]) {
      for (const [k, v] of map) {
        // An unknown DID / user may just have been created: never fall back to "unknown".
        if (v.value === null) map.delete(k);
        else if (v.value === tenantId) v.at = EXPIRED;
      }
    }
    metrics.configInvalidations.inc();
  }

  /** Everything may have changed (LISTEN reconnected): reload all, keep the values as fallbacks. */
  clear(): void {
    this.epoch++;
    for (const e of this.tenants.values()) e.at = EXPIRED;
    this.loading.clear();
    for (const map of [this.didToTenant, this.sipToTenant]) {
      for (const [k, v] of map) {
        if (v.value === null) map.delete(k);
        else v.at = EXPIRED;
      }
    }
    this.idLoading.clear();
    if (this.rates) this.rates.at = EXPIRED;
  }

  private fresh<T>(e: Entry<T> | null | undefined, ttl = this.ttlMs): boolean {
    return !!e && Date.now() - e.at < ttl;
  }

  /**
   * The load's result if it arrives within what is left of staleWaitMs (counted from the load's
   * start, so calls behind an already slow load don't wait again), else `stale`. A failed load
   * also returns `stale`.
   */
  private async loadOrStale<T>(load: Loading<T>, stale: T, kind: string, ctx: Record<string, unknown>): Promise<T> {
    let reason: unknown = null;
    try {
      const r = await within(load.promise, this.staleWaitMs - (Date.now() - load.since));
      if (r !== TIMED_OUT) return r;
    } catch (err) {
      reason = err;
    }
    metrics.configCache.inc({ result: 'stale' });
    const now = Date.now();
    if (now - (this.lastStaleLog.get(kind) ?? 0) >= STALE_LOG_EVERY_MS) {
      this.lastStaleLog.set(kind, now);
      this.log.warn(
        { ...ctx, err: reason ?? undefined, loadMs: now - load.since },
        reason ? `${kind} reload failed; using stale value` : `${kind} reload slow; using stale value`,
      );
    }
    return stale;
  }

  /** Load an account's snapshot (one load at a time per account), unless invalidated meanwhile. */
  private reload(tenantId: string): Loading<TenantConfig | null> {
    const running = this.loading.get(tenantId);
    if (running) return running;
    const gen = this.gen.get(tenantId) ?? 0;
    const epoch = this.epoch;
    const p = this.repo
      .loadTenant(tenantId)
      .then((cfg) => {
        const current = (this.gen.get(tenantId) ?? 0) === gen && this.epoch === epoch;
        if (current) {
          if (cfg) {
            const usedAt = this.tenants.get(tenantId)?.usedAt ?? Date.now();
            this.tenants.set(tenantId, { value: cfg, at: Date.now(), usedAt });
          } else {
            this.tenants.delete(tenantId); // account gone: no fallback either
          }
        }
        return cfg;
      })
      .finally(() => {
        if (this.loading.get(tenantId) === load) this.loading.delete(tenantId);
      });
    const load = startLoad(p);
    this.loading.set(tenantId, load);
    return load;
  }

  async tenant(tenantId: string): Promise<TenantConfig | null> {
    const hit = this.tenants.get(tenantId);
    if (hit && this.fresh(hit)) {
      hit.usedAt = Date.now();
      metrics.configCache.inc({ result: 'hit' });
      return hit.value;
    }
    metrics.configCache.inc({ result: 'miss' });
    const load = this.reload(tenantId);
    if (!hit) return load.promise;
    hit.usedAt = Date.now();
    return this.loadOrStale(load, hit.value, 'config', { tenantId });
  }

  /** DID / SIP user -> account id, with the same slow-DB fallback as the snapshots. */
  private async lookupId(
    map: Map<string, Entry<string | null>>,
    key: string,
    loader: () => Promise<string | null>,
  ): Promise<string | null> {
    const e = map.get(key);
    if (e && this.fresh(e, e.value === null ? this.negativeTtlMs : ID_TTL_MS)) return e.value;
    const loadKey = `${map === this.didToTenant ? 'did' : 'sip'}:${key}`;
    let load = this.idLoading.get(loadKey);
    if (!load) {
      const epoch = this.epoch;
      const p = loader()
        .then((id) => {
          if (this.epoch === epoch) map.set(key, { value: id, at: Date.now() });
          return id;
        })
        .finally(() => {
          if (this.idLoading.get(loadKey) === started) this.idLoading.delete(loadKey);
        });
      const started = startLoad(p);
      this.idLoading.set(loadKey, started);
      load = started;
    }
    if (!e || e.value === null) return load.promise;
    return this.loadOrStale(load, e.value, 'account id', { key });
  }

  async tenantForDid(dids: string[]): Promise<TenantConfig | null> {
    const id = await this.lookupId(this.didToTenant, dids.join(','), () => this.repo.tenantIdForDid(dids));
    return id ? this.tenant(id) : null;
  }

  async tenantForSipUser(sipUsername: string): Promise<TenantConfig | null> {
    const id = await this.lookupId(this.sipToTenant, sipUsername, () => this.repo.tenantIdForSipUser(sipUsername));
    return id ? this.tenant(id) : null;
  }

  async getRates(): Promise<Rates> {
    const cur = this.rates;
    if (cur && this.fresh(cur, 5 * 60_000)) return cur.value;
    if (!this.ratesLoading) {
      const p = this.repo
        .loadRates()
        .then((r) => {
          this.rates = { value: r, at: Date.now() };
          return r;
        })
        .finally(() => {
          if (this.ratesLoading === started) this.ratesLoading = null;
        });
      const started = startLoad(p);
      this.ratesLoading = started;
    }
    if (!cur) return this.ratesLoading.promise;
    return this.loadOrStale(this.ratesLoading, cur.value, 'rates', {});
  }

  /** Keep the snapshots of active accounts fresh in the background (every TTL/2). */
  startRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => this.refreshNow(), Math.max(1000, this.ttlMs / 2));
    this.refreshTimer.unref();
  }

  stopRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  /** One refresh pass: drop accounts idle for REFRESH_IDLE_MS, reload the others past TTL/2. */
  refreshNow(): void {
    const now = Date.now();
    for (const [tenantId, e] of this.tenants) {
      if (now - (e.usedAt ?? e.at) > REFRESH_IDLE_MS) {
        this.tenants.delete(tenantId);
        continue;
      }
      if (now - e.at >= this.ttlMs / 2) {
        // A failed reload keeps the current snapshot; a call after the TTL retries (and falls back
        // to it if the DB is still unreachable).
        this.reload(tenantId).promise.catch((err) => this.log.debug({ err, tenantId }, 'background config refresh failed'));
        metrics.configRefreshes.inc();
      }
    }
  }

  /** Warm the rate tables at startup so the first outgoing call doesn't wait. */
  async warm(): Promise<void> {
    await this.getRates().catch((err) => this.log.warn({ err }, 'could not preload rate decks'));
  }
}
