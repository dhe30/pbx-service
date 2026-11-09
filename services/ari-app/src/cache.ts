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

interface Entry<T> {
  value: T;
  at: number;
}

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
    this.tenants.delete(tenantId);
    for (const map of [this.didToTenant, this.sipToTenant]) {
      for (const [k, v] of map) if (v.value === tenantId || v.value === null) map.delete(k);
    }
    metrics.configInvalidations.inc();
  }

  clear(): void {
    this.tenants.clear();
    this.didToTenant.clear();
    this.sipToTenant.clear();
    this.rates = null;
  }

  private fresh<T>(e: Entry<T> | null | undefined, ttl = this.ttlMs): boolean {
    return !!e && Date.now() - e.at < ttl;
  }

  async tenant(tenantId: string): Promise<TenantConfig | null> {
    const hit = this.tenants.get(tenantId);
    if (hit && this.fresh(hit)) {
      metrics.configCache.inc({ result: 'hit' });
      return hit.value;
    }
    metrics.configCache.inc({ result: 'miss' });
    let p = this.loading.get(tenantId);
    if (!p) {
      p = this.repo
        .loadTenant(tenantId)
        .then((cfg) => {
          if (cfg) this.tenants.set(tenantId, { value: cfg, at: Date.now() });
          return cfg;
        })
        .finally(() => this.loading.delete(tenantId));
      this.loading.set(tenantId, p);
    }
    try {
      return await p;
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
    if (e && this.fresh(e, e.value === null ? this.negativeTtlMs : this.ttlMs)) id = e.value;
    else {
      id = await this.repo.tenantIdForDid(dids);
      this.didToTenant.set(key, { value: id, at: Date.now() });
    }
    return id ? this.tenant(id) : null;
  }

  async tenantForSipUser(sipUsername: string): Promise<TenantConfig | null> {
    const e = this.sipToTenant.get(sipUsername);
    let id: string | null;
    if (e && this.fresh(e, e.value === null ? this.negativeTtlMs : this.ttlMs)) id = e.value;
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

  /** Warm the rate tables at startup so the first outgoing call doesn't wait. */
  async warm(): Promise<void> {
    await this.getRates().catch((err) => this.log.warn({ err }, 'could not preload rate decks'));
  }
}
