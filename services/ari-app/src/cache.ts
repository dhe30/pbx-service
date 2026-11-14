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
 * exists, and NOTIFY pbx_config drops these entries on any change of the account, so they can
 * live much longer than the config snapshot.
 */
const ID_TTL_MS = 10 * 60_000;

export class ConfigCache {
  private readonly tenants = new Map<string, Entry<TenantConfig>>();
  private readonly loading = new Map<string, Promise<TenantConfig | null>>();
  /** DID / SIP user -> tenant id (null = unknown, cached briefly). */
  private readonly didToTenant = new Map<string, Entry<string | null>>();
  private readonly sipToTenant = new Map<string, Entry<string | null>>();
  private rates: Entry<Rates> | null = null;
  private ratesLoading: Promise<Rates> | null = null;
  private readonly ttlMs: number;
  private readonly negativeTtlMs = 5000;
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
  ) {
    this.ttlMs = ttlSec * 1000;
  }

  /** Subscribe to invalidations. Safe to call once at startup; reconnects are handled by postgres.js. */
  async listen(sql: Sql): Promise<void> {
    await sql.listen(
      NOTIFY_CONFIG_CHANNEL,
      (tenantId) => this.invalidateTenant(tenantId),
      // (Re)connected: anything could have changed while we weren't listening.
      () => this.clear(),
    );
    await sql.listen(NOTIFY_RATES_CHANNEL, () => (this.rates = null));
  }

  invalidateTenant(tenantId: string): void {
    this.gen.set(tenantId, (this.gen.get(tenantId) ?? 0) + 1);
    this.tenants.delete(tenantId);
    this.loading.delete(tenantId);
    for (const map of [this.didToTenant, this.sipToTenant]) {
      for (const [k, v] of map) if (v.value === tenantId || v.value === null) map.delete(k);
    }
    metrics.configInvalidations.inc();
  }

  clear(): void {
    this.epoch++;
    this.tenants.clear();
    this.loading.clear();
    this.didToTenant.clear();
    this.sipToTenant.clear();
    this.rates = null;
  }

  private fresh<T>(e: Entry<T> | null | undefined, ttl = this.ttlMs): boolean {
    return !!e && Date.now() - e.at < ttl;
  }

  /** Load an account's snapshot (one load at a time per account), unless invalidated meanwhile. */
  private reload(tenantId: string): Promise<TenantConfig | null> {
    const running = this.loading.get(tenantId);
    if (running) return running;
    const gen = this.gen.get(tenantId) ?? 0;
    const epoch = this.epoch;
    const p = this.repo
      .loadTenant(tenantId)
      .then((cfg) => {
        const current = (this.gen.get(tenantId) ?? 0) === gen && this.epoch === epoch;
        if (cfg && current) {
          const usedAt = this.tenants.get(tenantId)?.usedAt ?? Date.now();
          this.tenants.set(tenantId, { value: cfg, at: Date.now(), usedAt });
        }
        return cfg;
      })
      .finally(() => {
        if (this.loading.get(tenantId) === p) this.loading.delete(tenantId);
      });
    this.loading.set(tenantId, p);
    return p;
  }

  async tenant(tenantId: string): Promise<TenantConfig | null> {
    const hit = this.tenants.get(tenantId);
    if (hit && this.fresh(hit)) {
      hit.usedAt = Date.now();
      metrics.configCache.inc({ result: 'hit' });
      return hit.value;
    }
    metrics.configCache.inc({ result: 'miss' });
    try {
      return await this.reload(tenantId);
    } catch (err) {
      // DB unreachable: a stale snapshot beats failing the call.
      if (hit) {
        this.log.warn({ err, tenantId }, 'config reload failed; using stale snapshot');
        return hit.value;
      }
      throw err;
    }
  }

  async tenantForDid(dids: string[]): Promise<TenantConfig | null> {
    const key = dids.join(',');
    const e = this.didToTenant.get(key);
    let id: string | null;
    if (e && this.fresh(e, e.value === null ? this.negativeTtlMs : ID_TTL_MS)) id = e.value;
    else {
      id = await this.repo.tenantIdForDid(dids);
      this.didToTenant.set(key, { value: id, at: Date.now() });
    }
    return id ? this.tenant(id) : null;
  }

  async tenantForSipUser(sipUsername: string): Promise<TenantConfig | null> {
    const e = this.sipToTenant.get(sipUsername);
    let id: string | null;
    if (e && this.fresh(e, e.value === null ? this.negativeTtlMs : ID_TTL_MS)) id = e.value;
    else {
      id = await this.repo.tenantIdForSipUser(sipUsername);
      this.sipToTenant.set(sipUsername, { value: id, at: Date.now() });
    }
    return id ? this.tenant(id) : null;
  }

  async getRates(): Promise<Rates> {
    if (this.rates && this.fresh(this.rates, 5 * 60_000)) return this.rates.value;
    if (!this.ratesLoading) {
      this.ratesLoading = this.repo
        .loadRates()
        .then((r) => {
          this.rates = { value: r, at: Date.now() };
          return r;
        })
        .finally(() => (this.ratesLoading = null));
    }
    try {
      return await this.ratesLoading;
    } catch (err) {
      if (this.rates) return this.rates.value;
      throw err;
    }
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
        this.reload(tenantId).catch((err) => this.log.debug({ err, tenantId }, 'background config refresh failed'));
        metrics.configRefreshes.inc();
      }
    }
  }

  /** Warm the rate tables at startup so the first outgoing call doesn't wait. */
  async warm(): Promise<void> {
    await this.getRates().catch((err) => this.log.warn({ err }, 'could not preload rate decks'));
  }
}
