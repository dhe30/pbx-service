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
// [VERIFY] against the clone before relying on it (written from DIDWW's public v3 API):
//   - filters: available_dids filter[country.id] / [region.id] / [city.id] / [did_group_type.id] /
//     [number_contains]; dids filter[number]; regions / cities filter[country.id] (+ [region.id]);
//   - include=did_group.stock_keeping_units,did_group.did_group_type,did_group.city,did_group.region,
//     did_group.country
//     on available_dids;
//   - POST /orders with did_order_items {sku_id, available_did_id}; order status
//     Pending | Completed | Canceled;
//   - assigning a DID: PATCH /dids/:id relationship voice_in_trunk or voice_in_trunk_group;
//   - releasing: PATCH /dids/:id billing_cycles_count = 0 (stop renewing; works until the paid
//     cycle ends). Course spec: renewal every 7 days.
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

export class HttpDidwwProvider implements DidProvider {
  private readonly countryIds = new Map<string, Country & { id: string }>();
  private groupTypeIds: Map<NumberKind, string[]> | null = null;

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
    return country;
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

  private async groupTypes(kind: NumberKind): Promise<string[]> {
    if (!this.groupTypeIds) {
      const { data } = await this.list('/did_group_types');
      const m = new Map<NumberKind, string[]>([
        ['local', []],
        ['toll_free', []],
      ]);
      for (const t of data) m.get(kindOf(str(t.attributes?.name)))!.push(t.id);
      this.groupTypeIds = m;
    }
    return this.groupTypeIds.get(kind) ?? [];
  }

  private static INCLUDE = 'include=did_group.stock_keeping_units,did_group.did_group_type,did_group.city,did_group.region,did_group.country';

  async searchAvailable(q: AvailableSearch): Promise<AvailableNumber[]> {
    const c = await this.country(q.country);
    if (!c) return [];
    const f = [`filter[country.id]=${c.id}`];
    if (q.regionId) f.push(`filter[region.id]=${encodeURIComponent(q.regionId)}`);
    if (q.cityId) f.push(`filter[city.id]=${encodeURIComponent(q.cityId)}`);
    if (q.kind) {
      const ids = await this.groupTypes(q.kind);
      if (ids.length === 0) return [];
      f.push(`filter[did_group_type.id]=${ids.join(',')}`);
    }
    // No area code filter in the API: ask for numbers containing <calling code><area code>, then
    // keep those that start with it.
    const start = q.areaCode ? `+${c.prefix}${q.areaCode}` : null;
    if (start) f.push(`filter[number_contains]=${encodeURIComponent(start.slice(1))}`);
    const size = Math.min(100, start ? q.limit * 4 : q.limit);
    const doc = await this.list(`/available_dids?${f.join('&')}&page[size]=${size}&${HttpDidwwProvider.INCLUDE}`);
    return doc.data
      .map((r) => this.toAvailable(r, doc.included, c.iso))
      .filter((n): n is AvailableNumber => n !== null && (!start || n.number.startsWith(start)))
      .slice(0, q.limit);
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

  private toAvailable(r: Resource, included: Resource[], countryIso: string | null): AvailableNumber | null {
    const find = (rel: { id: string; type: string } | undefined) =>
      rel ? included.find((i) => i.id === rel.id && i.type === rel.type) : undefined;
    const one = (res: Resource | undefined, name: string) => {
      const d = res?.relationships?.[name]?.data;
      return Array.isArray(d) ? d[0] : (d ?? undefined);
    };
    const group = find(one(r, 'did_group'));
    const number = str(r.attributes?.number);
    // Cheapest SKU of the group (DIDWW SKUs differ in included channels).
    const skus = (group?.relationships?.stock_keeping_units?.data ?? []) as { id: string; type: string }[];
    const sku = skus
      .map((s) => find(s))
      .filter((s): s is Resource => s !== undefined)
      .sort((a, b) => Number(a.attributes?.monthly_price ?? 0) - Number(b.attributes?.monthly_price ?? 0))[0];
    const skuId = sku?.id ?? skus[0]?.id;
    if (!number || !skuId) return null; // can't be ordered without a SKU
    return {
      id: r.id,
      number: e164(number),
      kind: kindOf(str(find(one(group, 'did_group_type'))?.attributes?.name)),
      country: countryIso ?? str(find(one(group, 'country'))?.attributes?.iso) ?? '',
      region: str(find(one(group, 'region'))?.attributes?.name),
      city: str(find(one(group, 'city'))?.attributes?.name) ?? str(group?.attributes?.area_name),
      areaCode: str(group?.attributes?.prefix),
      skuId,
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

const places = (data: Resource[]): Place[] =>
  data
    .map((r) => ({ id: r.id, name: str(r.attributes?.name) ?? r.id }))
    .sort((a, b) => a.name.localeCompare(b.name));

function numberFromItems(order: Resource): string | null {
  const items = order.attributes?.items as { attributes?: { did_number?: unknown; number?: unknown } }[] | undefined;
  const n = str(items?.[0]?.attributes?.did_number) ?? str(items?.[0]?.attributes?.number);
  return n ? e164(n) : null;
}
