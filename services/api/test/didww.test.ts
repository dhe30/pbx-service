import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpDidwwProvider } from '../src/numbers/didww.js';
import { DidProviderError, NumberUnavailable } from '../src/numbers/provider.js';

// HttpDidwwProvider against a mock DIDWW v3 server (JSON:API). Checks what we send (paths,
// filters, headers, bodies) and that responses with `included` resources are read correctly.
// The mock copies the course clone's observed behaviour (read-only probes, 2026-11-11): on
// available_dids only include=did_group,did_group.stock_keeping_units is accepted (anything else
// -> 400), page[size] is ignored, and DID groups carry type/country/region/city as relationship
// ids plus prefix, area_name and is_metered. Order/assign/release are still [VERIFY]
// (src/numbers/didww.ts header).

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const US = { id: 'country-us', type: 'countries', attributes: { name: 'United States', prefix: '1', iso: 'US' } };
const rel = (type: string, id: string) => ({ data: { id, type } });
// DID groups as the clone returns them: attributes + relationship ids (types, places not includable).
const group = (id: string, prefix: string, areaName: string, opts: { city: string; region: string; type: string | null; metered: boolean; skus: string[] }) => ({
  id,
  type: 'did_groups',
  attributes: { prefix, area_name: areaName, features: ['voice_in'], is_metered: opts.metered, allow_additional_channels: false, service_restrictions: null },
  relationships: {
    address_requirement: { data: null },
    country: rel('countries', 'country-us'),
    city: rel('cities', opts.city),
    region: rel('regions', opts.region),
    did_group_type: opts.type ? rel('did_group_types', opts.type) : { data: null },
    stock_keeping_units: { data: opts.skus.map((s) => ({ id: s, type: 'stock_keeping_units' })) },
  },
});
const sku = (id: string, setup: string, weekly: string) => ({
  id,
  type: 'stock_keeping_units',
  attributes: { setup_price: setup, monthly_price: weekly, channels_included_count: 0 },
});
const INCLUDED = [
  group('grp-201', '201', 'Newark', { city: 'city-newark', region: 'reg-nj', type: 'type-local', metered: false, skus: ['sku-big', 'sku-small'] }),
  group('grp-973', '973', 'Paterson', { city: 'city-paterson', region: 'reg-nj', type: 'type-local', metered: false, skus: ['sku-small'] }),
  group('grp-800', '800', 'Toll-free', { city: 'city-tf', region: 'reg-tf', type: 'type-tf', metered: true, skus: ['sku-tf'] }),
  // No type id: falls back to is_metered.
  group('grp-888', '888', 'Toll-free', { city: 'city-tf', region: 'reg-tf', type: null, metered: true, skus: ['sku-tf'] }),
  sku('sku-big', '0.00', '5.00'),
  sku('sku-small', '0.00', '1.50'),
  sku('sku-tf', '2.00', '3.00'),
];
const offer = (id: string, number: string, groupId = 'grp-201') => ({
  id,
  type: 'available_dids',
  attributes: { number },
  relationships: { did_group: rel('did_groups', groupId), nanpa_prefix: { data: null } },
});
const OFFERS = [
  offer('av-1', '12015550101'),
  offer('av-2', '19735550101', 'grp-973'),
  offer('av-3', '12015550102'),
  offer('av-tf', '18005550100', 'grp-800'),
  offer('av-tf2', '18885550100', 'grp-888'),
];
const OK_INCLUDES = new Set(['did_group', 'did_group.stock_keeping_units']);

describe('HttpDidwwProvider', () => {
  const seen: Seen[] = [];
  let server: Server;
  let didww: HttpDidwwProvider;
  let orderStatus = 'Completed';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
        const send = (status: number, doc: unknown) => {
          res.writeHead(status, { 'content-type': 'application/vnd.api+json' });
          res.end(JSON.stringify(doc));
        };
        const url = new URL(req.url!, 'http://x');
        if (req.headers['api-key'] !== 'secret-key') return send(401, { errors: [{ title: 'Unauthorized' }] });
        if (url.pathname === '/v3/countries') return send(200, { data: [US] });
        if (url.pathname === '/v3/did_group_types') {
          return send(200, {
            data: [
              { id: 'type-local', type: 'did_group_types', attributes: { name: 'Local' } },
              { id: 'type-tf', type: 'did_group_types', attributes: { name: 'Toll-free' } },
            ],
          });
        }
        if (url.pathname === '/v3/regions') {
          return send(200, { data: [{ id: 'reg-nj', type: 'regions', attributes: { name: 'New Jersey', iso: 'US-NJ' } }] });
        }
        if (url.pathname === '/v3/cities') {
          return send(200, {
            data: [
              { id: 'city-newark', type: 'cities', attributes: { name: 'Newark' } },
              { id: 'city-paterson', type: 'cities', attributes: { name: 'Paterson' } },
            ],
          });
        }
        if (url.pathname.startsWith('/v3/available_dids')) {
          // Like the clone: unknown includes are a 400. The LIST accepts did_group and
          // did_group.stock_keeping_units; a single offer (GET /available_dids/:id) rejects the
          // SKUs (seen 2026-11-11: it broke every purchase).
          const single = url.pathname !== '/v3/available_dids';
          const ok = single ? new Set(['did_group']) : OK_INCLUDES;
          const bad = (url.searchParams.get('include') ?? '').split(',').filter((i) => i && !ok.has(i));
          if (bad.length) return send(400, { errors: [{ title: 'Invalid field', detail: `${bad[0]} is not a valid includable relationship of this resource.` }] });
        }
        // Like the clone: page[size] is ignored and the filters aren't applied here, so the
        // provider has to re-check them itself.
        if (url.pathname === '/v3/available_dids') return send(200, { data: OFFERS, included: INCLUDED });
        if (url.pathname === '/v3/available_dids/av-1') return send(200, { data: offer('av-1', '12015550101') });
        if (url.pathname === '/v3/available_dids/av-tf') return send(200, { data: offer('av-tf', '18005550100', 'grp-800') });
        if (url.pathname === '/v3/available_dids/gone') return send(404, { errors: [{ title: 'Not found' }] });
        // A DID group with its SKUs (what getAvailable reads for a single offer).
        const grp = url.pathname.match(/^\/v3\/did_groups\/([^/]+)$/);
        if (grp) {
          const g = INCLUDED.find((r) => r.type === 'did_groups' && r.id === grp[1]);
          if (!g) return send(404, { errors: [{ title: 'Not found' }] });
          const skuIds = new Set((g as { relationships: { stock_keeping_units: { data: { id: string }[] } } }).relationships.stock_keeping_units.data.map((s) => s.id));
          const withSkus = url.searchParams.get('include') === 'stock_keeping_units';
          return send(200, { data: g, ...(withSkus && { included: INCLUDED.filter((r) => r.type === 'stock_keeping_units' && skuIds.has(r.id)) }) });
        }
        if (url.pathname === '/v3/orders' && req.method === 'POST') {
          const item = (JSON.parse(raw) as { data: { attributes: { items: { attributes: { available_did_id: string } }[] } } }).data.attributes
            .items[0]!.attributes;
          if (item.available_did_id === 'taken') return send(422, { errors: [{ title: 'DID is not available', detail: 'reserved' }] });
          return send(201, { data: { id: 'ord-1', type: 'orders', attributes: { status: orderStatus, items: [] } } });
        }
        if (url.pathname === '/v3/orders/ord-1') return send(200, { data: { id: 'ord-1', type: 'orders', attributes: { status: 'Completed' } } });
        if (url.pathname === '/v3/dids' && url.searchParams.get('filter[number]') === '12015550101') {
          return send(200, { data: [{ id: 'did-9', type: 'dids', attributes: { number: '12015550101' } }] });
        }
        if (url.pathname === '/v3/dids') return send(200, { data: [] });
        if (url.pathname === '/v3/dids/did-9' && req.method === 'PATCH') return send(200, { data: { id: 'did-9', type: 'dids' } });
        if (url.pathname === '/v3/boom') return send(500, { errors: [{ title: 'Internal', detail: 'oops' }] });
        return send(404, { errors: [{ title: 'Not found' }] });
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    didww = new HttpDidwwProvider({
      baseUrl: `http://127.0.0.1:${port}/v3/`,
      apiKey: 'secret-key',
      trunk: { type: 'voice_in_trunk_groups', id: 'tg-1' },
    });
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const last = (path: string) => [...seen].reverse().find((s) => s.url.startsWith(path))!;

  it('sends the Api-Key and JSON:API headers', async () => {
    await didww.countries();
    const s = last('/v3/countries');
    expect(s.headers['api-key']).toBe('secret-key');
    expect(s.headers.accept).toBe('application/vnd.api+json');
  });

  it('searches by country, type and area code with only the includes the clone accepts', async () => {
    const res = await didww.searchAvailable({ country: 'us', areaCode: '201', kind: 'local', limit: 5 });
    const url = new URL(last('/v3/available_dids?').url, 'http://x');
    expect(url.searchParams.get('filter[country.id]')).toBe('country-us');
    expect(url.searchParams.get('filter[did_group_type.id]')).toBe('type-local');
    expect(url.searchParams.get('filter[number_contains]')).toBe('1201');
    expect(url.searchParams.get('include')).toBe('did_group,did_group.stock_keeping_units');
    // Kind, region and city come from the group's relationship ids + the cached lookups. The
    // "contains" filter and the ignored type filter are re-checked: no av-2 (+1973), no toll-free.
    expect(res).toEqual([
      { id: 'av-1', number: '+12015550101', kind: 'local', country: 'US', region: 'New Jersey', city: 'Newark', areaCode: '201', skuId: 'sku-small', incomingCostPerMin: null },
      { id: 'av-3', number: '+12015550102', kind: 'local', country: 'US', region: 'New Jersey', city: 'Newark', areaCode: '201', skuId: 'sku-small', incomingCostPerMin: null },
    ]);
    expect(res).toHaveLength(2);
    expect(await didww.searchAvailable({ country: 'ZZ', limit: 5 })).toEqual([]);
  });

  it('re-checks the city and region filters, and honours the limit (the clone ignores page[size])', async () => {
    const paterson = await didww.searchAvailable({ country: 'US', cityId: 'city-paterson', limit: 5 });
    expect(paterson.map((n) => n.id)).toEqual(['av-2']);
    expect(new URL(last('/v3/available_dids?').url, 'http://x').searchParams.get('filter[city.id]')).toBe('city-paterson');
    const nj = await didww.searchAvailable({ country: 'US', regionId: 'reg-nj', limit: 2 });
    expect(nj.map((n) => n.id)).toEqual(['av-1', 'av-2']);
  });

  it('finds toll-free numbers and prices them from the published per-minute rate', async () => {
    const tf = await didww.searchAvailable({ country: 'US', kind: 'toll_free', limit: 5 });
    expect(new URL(last('/v3/available_dids?').url, 'http://x').searchParams.get('filter[did_group_type.id]')).toBe('type-tf');
    // av-tf2's group has no type id: is_metered says toll-free.
    expect(tf.map((n) => [n.id, n.kind, n.areaCode, n.skuId, n.incomingCostPerMin])).toEqual([
      ['av-tf', 'toll_free', '800', 'sku-tf', 0.025],
      ['av-tf2', 'toll_free', '888', 'sku-tf', 0.025],
    ]);
    // Places the group doesn't name in the city list fall back to the group's area name.
    expect(tf[0]).toMatchObject({ city: 'Toll-free', region: null, country: 'US' });
  });

  it('gets one offer (country from the group), or null if it is gone', async () => {
    expect(await didww.getAvailable('av-1')).toMatchObject({ number: '+12015550101', country: 'US', city: 'Newark', skuId: 'sku-small' });
    // The single-offer GET carries no SKU include (the clone rejects it); the SKUs come from the group.
    expect(new URL(last('/v3/available_dids/av-1').url, 'http://x').searchParams.get('include')).toBeNull();
    expect(new URL(last('/v3/did_groups/grp-201').url, 'http://x').searchParams.get('include')).toBe('stock_keeping_units');
    expect(await didww.getAvailable('av-tf')).toMatchObject({ kind: 'toll_free', country: 'US', incomingCostPerMin: 0.025 });
    expect(await didww.getAvailable('gone')).toBeNull();
  });

  it('orders with the SKU and offer id, and finds the DID', async () => {
    const o = (await didww.getAvailable('av-1'))!;
    orderStatus = 'Completed';
    expect(await didww.order(o)).toEqual({ orderId: 'ord-1', did: { id: 'did-9', number: '+12015550101' } });
    expect(last('/v3/orders').body).toEqual({
      data: {
        type: 'orders',
        attributes: { allow_back_ordering: false, items: [{ type: 'did_order_items', attributes: { sku_id: 'sku-small', available_did_id: 'av-1' } }] },
      },
    });
    expect(last('/v3/orders').headers['content-type']).toBe('application/vnd.api+json');

    orderStatus = 'Pending';
    expect(await didww.order(o)).toEqual({ orderId: 'ord-1', did: null });
    await expect(didww.order({ ...o, id: 'taken' })).rejects.toBeInstanceOf(NumberUnavailable);
    orderStatus = 'Canceled';
    await expect(didww.order(o)).rejects.toBeInstanceOf(NumberUnavailable);
  });

  it('finds owned DIDs by number', async () => {
    expect(await didww.findOwnedDid('+12015550101')).toEqual({ id: 'did-9', number: '+12015550101' });
    expect(new URL(last('/v3/dids?').url, 'http://x').searchParams.get('filter[number]')).toBe('12015550101');
    expect(await didww.findOwnedDid('+19999999999')).toBeNull();
  });

  it('assigns to the trunk group and releases by stopping renewal', async () => {
    await didww.assignToTrunk('did-9');
    expect(last('/v3/dids/did-9').body).toEqual({
      data: { type: 'dids', id: 'did-9', relationships: { voice_in_trunk_group: { data: { type: 'voice_in_trunk_groups', id: 'tg-1' } } } },
    });
    await didww.release('did-9');
    expect(last('/v3/dids/did-9').body).toEqual({ data: { type: 'dids', id: 'did-9', attributes: { billing_cycles_count: 0 } } });
  });

  it('turns errors into DidProviderError with the first JSON:API error', async () => {
    const bad = new HttpDidwwProvider({ baseUrl: (didww as unknown as { o: { baseUrl: string } }).o.baseUrl, apiKey: 'wrong', trunk: { type: 'voice_in_trunks', id: 't' } });
    const err = await bad.countries().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DidProviderError);
    expect(err).toMatchObject({ status: 401, message: expect.stringContaining('Unauthorized') });
    const down = new HttpDidwwProvider({ baseUrl: 'http://127.0.0.1:1/v3', apiKey: 'k', trunk: { type: 'voice_in_trunks', id: 't' } });
    await expect(down.countries()).rejects.toMatchObject({ status: null, message: expect.stringContaining('unreachable') });
  });
});

describe('tollFreeCostPerMin', () => {
  it('uses the per-minute rates published on the Course Services tab, toll-free only', async () => {
    const { tollFreeCostPerMin } = await import('../src/numbers/didww.js');
    expect(tollFreeCostPerMin('toll_free', 'US')).toBe(0.025);
    expect(tollFreeCostPerMin('toll_free', 'gb')).toBe(0.05);
    expect(tollFreeCostPerMin('toll_free', 'DE')).toBeNull(); // unknown -> call_pricing default
    expect(tollFreeCostPerMin('local', 'US')).toBeNull(); // "Other numbers: no per-minute charge"
  });
});
