import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpDidwwProvider } from '../src/numbers/didww.js';
import { DidProviderError, NumberUnavailable } from '../src/numbers/provider.js';

// HttpDidwwProvider against a mock DIDWW v3 server (JSON:API). Checks what we send (paths,
// filters, headers, bodies) and that responses with `included` resources are read correctly.
// The real clone's details are still [VERIFY] (src/numbers/didww.ts header).

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const US = { id: 'country-us', type: 'countries', attributes: { name: 'United States', prefix: '1', iso: 'US' } };
const GROUP = {
  id: 'grp-201',
  type: 'did_groups',
  attributes: { prefix: '201', area_name: 'Newark' },
  relationships: {
    country: { data: { id: 'country-us', type: 'countries' } },
    city: { data: { id: 'city-newark', type: 'cities' } },
    region: { data: { id: 'reg-nj', type: 'regions' } },
    did_group_type: { data: { id: 'type-local', type: 'did_group_types' } },
    stock_keeping_units: {
      data: [
        { id: 'sku-big', type: 'stock_keeping_units' },
        { id: 'sku-small', type: 'stock_keeping_units' },
      ],
    },
  },
};
const INCLUDED = [
  GROUP,
  US,
  { id: 'city-newark', type: 'cities', attributes: { name: 'Newark' } },
  { id: 'reg-nj', type: 'regions', attributes: { name: 'New Jersey' } },
  { id: 'type-local', type: 'did_group_types', attributes: { name: 'Local' } },
  { id: 'sku-big', type: 'stock_keeping_units', attributes: { monthly_price: '5.00', channels_included_count: 10 } },
  { id: 'sku-small', type: 'stock_keeping_units', attributes: { monthly_price: '1.00', channels_included_count: 2 } },
];
const offer = (id: string, number: string) => ({
  id,
  type: 'available_dids',
  attributes: { number },
  relationships: { did_group: { data: { id: 'grp-201', type: 'did_groups' } } },
});

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
        if (url.pathname === '/v3/available_dids') {
          return send(200, {
            data: [offer('av-1', '12015550101'), offer('av-2', '19735550101'), offer('av-3', '12015550102')],
            included: INCLUDED,
          });
        }
        if (url.pathname === '/v3/available_dids/av-1') return send(200, { data: offer('av-1', '12015550101'), included: INCLUDED });
        if (url.pathname === '/v3/available_dids/gone') return send(404, { errors: [{ title: 'Not found' }] });
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

  it('searches by country, type and area code, reading included resources', async () => {
    const res = await didww.searchAvailable({ country: 'us', areaCode: '201', kind: 'local', limit: 5 });
    const url = new URL(last('/v3/available_dids?').url, 'http://x');
    expect(url.searchParams.get('filter[country.id]')).toBe('country-us');
    expect(url.searchParams.get('filter[did_group_type.id]')).toBe('type-local');
    expect(url.searchParams.get('filter[number_contains]')).toBe('1201');
    expect(url.searchParams.get('include')).toContain('did_group.stock_keeping_units');
    // The filter is "contains": only numbers starting with +1201 are kept (not av-2, +1973...).
    expect(res).toEqual([
      { id: 'av-1', number: '+12015550101', kind: 'local', country: 'US', region: 'New Jersey', city: 'Newark', areaCode: '201', skuId: 'sku-small' },
      { id: 'av-3', number: '+12015550102', kind: 'local', country: 'US', region: 'New Jersey', city: 'Newark', areaCode: '201', skuId: 'sku-small' },
    ]);
    expect(await didww.searchAvailable({ country: 'ZZ', limit: 5 })).toEqual([]);
  });

  it('gets one offer, or null if it is gone', async () => {
    expect(await didww.getAvailable('av-1')).toMatchObject({ number: '+12015550101', country: 'US', skuId: 'sku-small' });
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
