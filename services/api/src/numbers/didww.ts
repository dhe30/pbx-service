import {
  DidProviderError,
  NumberUnavailable,
  type AvailableNumber,
  type AvailableSearch,
  type Country,
  type DidProvider,
  type NumberKind,
  type OrderResult,
  type Place,
} from './provider.js';

// DID provider client for the course's DIDWW API v3 clone (CLAUDE.md §3 A6, docs/cloud-deploy.md
// §3.2). JSON:API over HTTPS, authenticated with the `Api-Key` header.
//
// CHECKED against the clone (read-only probes, 2026-11-11; shapes pinned in test/didww.test.ts):
//   - filters accepted: available_dids filter[country.id] / [region.id] / [city.id] /
//     [did_group_type.id] / [number_contains]; dids filter[number] / [order.id]; regions / cities
//     filter[country.id] (+ [region.id]). The did_group.-prefixed spellings are rejected (400).
//   - available_dids accepts ONLY include=did_group and did_group.stock_keeping_units (city,
//     region, country, did_group_type -> 400). A DID group carries those as relationship ids, plus
//     area_name, prefix and is_metered (true = toll-free); names are looked up and cached here.
//   - available_dids ignores page[size] (returns up to 100), so we can't tell from a probe whether
//     the region/city/type filters are applied: every one is re-checked on the results.
//   - SKU attributes: setup_price, monthly_price (the price per 7-day renewal period despite the
//     name), channels_included_count.
//   - The incoming toll-free per-minute fee is NOT in the API: the Course Services tab publishes it
//     (TOLL_FREE_IN_COST_PER_MIN below). "Setup and weekly prices are in the API" = the SKU.
// Still [VERIFY] (needs a purchase; the probes were GET-only):
//   - POST /orders with did_order_items {sku_id, available_did_id}; order status
//     Pending | Completed | Canceled;
//   - assigning a DID: PATCH /dids/:id relationship voice_in_trunk or voice_in_trunk_group;
//   - releasing: PATCH /dids/:id billing_cycles_count = 0 (stop renewing; works until the paid
//     cycle ends). The course spec says a released number works until its paid period ends, "then
//     release it at the provider": check whether the clone needs an explicit call at that point.
// Everything provider-specific stays in this file; src/numbers/purchase.ts only sees DidProvider.

interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | { id: string; type: string }[] | null }>;
}

interface Document {
  data: Resource | Resource[];
  included?: Resource[];
}

export interface DidwwOptions {
  baseUrl: string;
  apiKey: string;
  /** Inbound trunk to assign new DIDs to (voice_in_trunks id), or a trunk group (A7: both edges). */
  trunk: { type: 'voice_in_trunks' | 'voice_in_trunk_groups'; id: string };
  timeoutMs?: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null);
const e164 = (digits: string) => (digits.startsWith('+') ? digits : `+${digits}`);
const kindOf = (groupTypeName: string | null): NumberKind => (/toll.?free/i.test(groupTypeName ?? '') ? 'toll_free' : 'local');

/**
 * What the DID provider charges us per minute of an answered incoming call to a toll-free number,
 * by country ISO (USD). Not in the API: published on the Course Services tab ("Incoming minutes",
 * read 2026-11-11: United Kingdom Toll-free $0.05, United States Toll-free $0.025; other numbers
 * no per-minute charge). Billed per second. A country missing here gets null, and the ARI app then
 * uses call_pricing.toll_free_in_cost_per_min. Update this if the tab changes.
 */
export const TOLL_FREE_IN_COST_PER_MIN: Readonly<Record<string, number>> = { US: 0.025, GB: 0.05 };

export function tollFreeCostPerMin(kind: NumberKind, countryIso: string): number | null {
  return kind === 'toll_free' ? (TOLL_FREE_IN_COST_PER_MIN[countryIso.toUpperCase()] ?? null) : null;
}

type Rel = { id: string; type: string };
const relOf = (res: Resource | undefined, name: string): Rel | undefined => {
  const d = res?.relationships?.[name]?.data;
  return Array.isArray(d) ? d[0] : (d ?? undefined);
};

export class HttpDidwwProvider implements DidProvider {
  private readonly countryIds = new Map<string, Country & { id: string }>();
  private readonly countriesById = new Map<string, Country & { id: string }>();
  /** did_group_types id -> name (5 types, loaded once). */
  private groupTypeNames: Map<string, string> | null = null;
  /** Per country id: region and city id -> name, for describing offers (loaded once per country). */
  private readonly placeNames = new Map<string, Promise<{ regions: Map<string, string>; cities: Map<string, string> }>>();

  constructor(private readonly o: DidwwOptions) {}

  private async request(method: string, path: string, body?: unknown): Promise<Document> {
    const url = `${this.o.baseUrl.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'Api-Key': this.o.apiKey,
          Accept: 'application/vnd.api+json',
          ...(body !== undefined && { 'Content-Type': 'application/vnd.api+json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new DidProviderError(`DID provider unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // JSON:API errors: { errors: [{ title, detail, code }] }. Only the first is kept.
      let detail = text.slice(0, 300);
      try {
        const e = (JSON.parse(text) as { errors?: { title?: string; detail?: string }[] }).errors?.[0];
        if (e) detail = [e.title, e.detail].filter(Boolean).join(': ');
      } catch {
        /* not JSON */
      }
      if (res.status === 404) throw new DidProviderError(`not found: ${method} ${path}`, 404);
      throw new DidProviderError(`DID provider ${method} ${path} -> ${res.status}: ${detail}`, res.status);
    }
    try {
      return JSON.parse(text) as Document;
    } catch {
      throw new DidProviderError(`DID provider ${method} ${path}: response is not JSON`);
    }
  }

  private async list(path: string): Promise<{ data: Resource[]; included: Resource[] }> {
    const doc = await this.request('GET', path);
    return { data: Array.isArray(doc.data) ? doc.data : [doc.data], included: doc.included ?? [] };
  }

  private async country(iso: string): Promise<(Country & { id: string }) | null> {
    const key = iso.toUpperCase();
    const hit = this.countryIds.get(key);
    if (hit) return hit;
    const { data } = await this.list(`/countries?filter[iso]=${encodeURIComponent(key)}`);
    // Match the ISO ourselves too, in case the filter is ignored.
    const c = data.find((r) => str(r.attributes?.iso)?.toUpperCase() === key);
    if (!c) return null;
    const country = { id: c.id, iso: key, name: str(c.attributes?.name) ?? key, prefix: str(c.attributes?.prefix) ?? '' };
    this.countryIds.set(key, country);
    this.countriesById.set(c.id, country);
    return country;
  }

  /** Country of a DID group, by the group's country relationship id (getAvailable has no ISO). */
  private async countryById(id: string): Promise<(Country & { id: string }) | null> {
    if (!this.countriesById.has(id)) {
      const { data } = await this.list('/countries?page[size]=500');
      for (const c of data) {
        const iso = str(c.attributes?.iso)?.toUpperCase();
        if (!iso) continue;
        const country = { id: c.id, iso, name: str(c.attributes?.name) ?? iso, prefix: str(c.attributes?.prefix) ?? '' };
        this.countriesById.set(c.id, country);
        this.countryIds.set(iso, country);
      }
    }
    return this.countriesById.get(id) ?? null;
  }

  private places(countryId: string) {
    let p = this.placeNames.get(countryId);
    if (!p) {
      const names = (rs: Resource[]) => new Map(rs.map((r) => [r.id, str(r.attributes?.name) ?? r.id]));
      p = Promise.all([
        this.list(`/regions?filter[country.id]=${countryId}&page[size]=500`),
        this.list(`/cities?filter[country.id]=${countryId}&page[size]=500`),
      ]).then(([r, c]) => ({ regions: names(r.data), cities: names(c.data) }));
      // A failed lookup isn't cached: the next search tries again.
      p.catch(() => this.placeNames.delete(countryId));
      this.placeNames.set(countryId, p);
    }
    return p;
  }

  async countries(): Promise<Country[]> {
    const { data } = await this.list('/countries?page[size]=500');
    return data
      .map((c) => ({ iso: str(c.attributes?.iso) ?? '', name: str(c.attributes?.name) ?? '', prefix: str(c.attributes?.prefix) ?? '' }))
      .filter((c) => c.iso !== '')
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async regions(country: string): Promise<Place[]> {
    const c = await this.country(country);
    if (!c) return [];
    const { data } = await this.list(`/regions?filter[country.id]=${c.id}&page[size]=500`);
    return places(data);
  }

  async cities(country: string, regionId?: string): Promise<Place[]> {
    const c = await this.country(country);
    if (!c) return [];
    const region = regionId ? `&filter[region.id]=${encodeURIComponent(regionId)}` : '';
    const { data } = await this.list(`/cities?filter[country.id]=${c.id}${region}&page[size]=500`);
    return places(data);
  }

  private async groupTypes(): Promise<Map<string, string>> {
    if (!this.groupTypeNames) {
      const { data } = await this.list('/did_group_types');
      this.groupTypeNames = new Map(data.map((t) => [t.id, str(t.attributes?.name) ?? '']));
    }
    return this.groupTypeNames;
  }

  /** The only includes the clone accepts on available_dids (see the header). */
  private static INCLUDE = 'include=did_group,did_group.stock_keeping_units';

  async searchAvailable(q: AvailableSearch): Promise<AvailableNumber[]> {
    const c = await this.country(q.country);
    if (!c) return [];
    const f = [`filter[country.id]=${c.id}`];
    if (q.regionId) f.push(`filter[region.id]=${encodeURIComponent(q.regionId)}`);
    if (q.cityId) f.push(`filter[city.id]=${encodeURIComponent(q.cityId)}`);
    if (q.kind) {
      const types = await this.groupTypes();
      const ids = [...types].filter(([, name]) => kindOf(name) === q.kind).map(([id]) => id);
      if (ids.length === 0) return [];
      f.push(`filter[did_group_type.id]=${ids.join(',')}`);
    }
    // No area code filter in the API: ask for numbers containing <calling code><area code>, then
    // keep those that start with it.
    const start = q.areaCode ? `+${c.prefix}${q.areaCode}` : null;
    if (start) f.push(`filter[number_contains]=${encodeURIComponent(start.slice(1))}`);
    const size = Math.min(100, start ? q.limit * 4 : q.limit);
    const doc = await this.list(`/available_dids?${f.join('&')}&page[size]=${size}&${HttpDidwwProvider.INCLUDE}`);
    const out: AvailableNumber[] = [];
    for (const r of doc.data) {
      // Re-check every filter on the result: the clone's filters can't be observed (see header).
      const group = included(doc.included, relOf(r, 'did_group'));
      if (q.regionId && !relMatches(group, 'region', q.regionId)) continue;
      if (q.cityId && !relMatches(group, 'city', q.cityId)) continue;
      const n = await this.toAvailable(r, doc.included, c);
      if (!n || (start && !n.number.startsWith(start)) || (q.kind && n.kind !== q.kind)) continue;
      out.push(n);
      if (out.length >= q.limit) break;
    }
    return out;
  }

  async getAvailable(id: string): Promise<AvailableNumber | null> {
    let doc: Document;
    try {
      doc = await this.request('GET', `/available_dids/${encodeURIComponent(id)}?${HttpDidwwProvider.INCLUDE}`);
    } catch (err) {
      if (err instanceof DidProviderError && err.status === 404) return null;
      throw err;
    }
    const r = Array.isArray(doc.data) ? doc.data[0] : doc.data;
    if (!r) return null;
    return this.toAvailable(r, doc.included ?? [], null);
  }

  /**
   * One offer as an AvailableNumber. The clone only includes the DID group and its SKUs; the
   * group's type, country, region and city come as relationship ids and are named from cached
   * lookups (did_group_types, countries, regions, cities). Null if it can't be ordered (no SKU).
   */
  private async toAvailable(r: Resource, inc: Resource[], country: (Country & { id: string }) | null): Promise<AvailableNumber | null> {
    const group = included(inc, relOf(r, 'did_group'));
    const number = str(r.attributes?.number);
    // Cheapest SKU of the group (DIDWW SKUs differ in included channels).
    const skus = (group?.relationships?.stock_keeping_units?.data ?? []) as Rel[];
    const sku = skus
      .map((s) => included(inc, s))
      .filter((s): s is Resource => s !== undefined)
      .sort((a, b) => Number(a.attributes?.monthly_price ?? 0) - Number(b.attributes?.monthly_price ?? 0))[0];
    const skuId = sku?.id ?? skus[0]?.id;
    if (!number || !skuId) return null; // can't be ordered without a SKU

    const typeId = relOf(group, 'did_group_type')?.id;
    const typeName = typeId ? ((await this.groupTypes()).get(typeId) ?? null) : null;
    // The type's name decides; is_metered (true for toll-free in the clone) when the type is unknown.
    const kind: NumberKind = typeName ? kindOf(typeName) : group?.attributes?.is_metered === true ? 'toll_free' : 'local';

    const countryId = relOf(group, 'country')?.id;
    const c = country ?? (countryId ? await this.countryById(countryId) : null);
    // Region/city names are nice-to-have: an outage of those lookups must not break buying.
    const names = c ? await this.places(c.id).catch(() => null) : null;
    const regionId = relOf(group, 'region')?.id;
    const cityId = relOf(group, 'city')?.id;
    return {
      id: r.id,
      number: e164(number),
      kind,
      country: c?.iso ?? '',
      region: (regionId && names?.regions.get(regionId)) || null,
      city: (cityId && names?.cities.get(cityId)) || str(group?.attributes?.area_name),
      areaCode: str(group?.attributes?.prefix),
      skuId,
      incomingCostPerMin: tollFreeCostPerMin(kind, c?.iso ?? ''),
    };
  }

  async order(offer: AvailableNumber): Promise<OrderResult> {
    let doc: Document;
    try {
      doc = await this.request('POST', '/orders', {
        data: {
          type: 'orders',
          attributes: {
            allow_back_ordering: false,
            items: [{ type: 'did_order_items', attributes: { sku_id: offer.skuId, available_did_id: offer.id } }],
          },
        },
      });
    } catch (err) {
      // The offer was taken between search and order (DIDWW answers 422 / 404 for that).
      if (err instanceof DidProviderError && (err.status === 422 || err.status === 404 || err.status === 409)) {
        throw new NumberUnavailable(err.message);
      }
      throw err;
    }
    const order = Array.isArray(doc.data) ? doc.data[0]! : doc.data;
    return this.orderResult(order, offer.number);
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    const doc = await this.request('GET', `/orders/${encodeURIComponent(orderId)}`);
    const order = Array.isArray(doc.data) ? doc.data[0]! : doc.data;
    return this.orderResult(order, null);
  }

  private async orderResult(order: Resource, number: string | null): Promise<OrderResult> {
    const status = str(order.attributes?.status)?.toLowerCase();
    if (status === 'canceled' || status === 'cancelled') throw new NumberUnavailable(`order ${order.id} was canceled`);
    if (status !== 'completed') return { orderId: order.id, did: null };
    // Completed: find the DID (the order lists items, not DID ids).
    const n = number ?? numberFromItems(order);
    const did = n ? await this.findOwnedDid(n) : null;
    if (!did) {
      const byOrder = await this.list(`/dids?filter[order.id]=${encodeURIComponent(order.id)}`);
      const d = byOrder.data[0];
      return { orderId: order.id, did: d ? { id: d.id, number: e164(str(d.attributes?.number) ?? '') } : null };
    }
    return { orderId: order.id, did };
  }

  async findOwnedDid(number: string): Promise<{ id: string; number: string } | null> {
    const { data } = await this.list(`/dids?filter[number]=${encodeURIComponent(number.replace(/^\+/, ''))}`);
    const d = data[0];
    return d ? { id: d.id, number: e164(str(d.attributes?.number) ?? number) } : null;
  }

  async assignToTrunk(didId: string): Promise<void> {
    const rel = this.o.trunk.type === 'voice_in_trunks' ? 'voice_in_trunk' : 'voice_in_trunk_group';
    await this.request('PATCH', `/dids/${encodeURIComponent(didId)}`, {
      data: { type: 'dids', id: didId, relationships: { [rel]: { data: { type: this.o.trunk.type, id: this.o.trunk.id } } } },
    });
  }

  async release(didId: string): Promise<void> {
    await this.request('PATCH', `/dids/${encodeURIComponent(didId)}`, {
      data: { type: 'dids', id: didId, attributes: { billing_cycles_count: 0 } },
    });
  }
}

const included = (inc: Resource[], rel: Rel | undefined) => (rel ? inc.find((i) => i.id === rel.id && i.type === rel.type) : undefined);

/** True when the group's relationship has this id, or when the group doesn't say (can't tell). */
const relMatches = (group: Resource | undefined, name: string, id: string) => {
  const rel = relOf(group, name);
  return rel === undefined || rel.id === id;
};

const places = (data: Resource[]): Place[] =>
  data
    .map((r) => ({ id: r.id, name: str(r.attributes?.name) ?? r.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

function numberFromItems(order: Resource): string | null {
  const items = order.attributes?.items as { attributes?: { did_number?: unknown; number?: unknown } }[] | undefined;
  const n = str(items?.[0]?.attributes?.did_number) ?? str(items?.[0]?.attributes?.number);
  return n ? e164(n) : null;
}
