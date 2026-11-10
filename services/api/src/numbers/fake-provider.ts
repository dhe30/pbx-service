import {
  DidProviderError,
  NumberUnavailable,
  type AvailableNumber,
  type AvailableSearch,
  type Country,
  type DidProvider,
  type OrderResult,
  type Place,
} from './provider.js';

// In-memory DID provider for tests and local dev (DID_PROVIDER_MODE=fake). Sells fictional
// 555-01xx numbers in a few US area codes plus toll-free. State lives in this process only, so
// use it with one API instance.

interface AreaCode {
  regionId: string;
  region: string;
  cityId: string;
  city: string;
  areaCode: string;
  kind: 'local' | 'toll_free';
}

const AREAS: AreaCode[] = [
  { regionId: 'r-nj', region: 'New Jersey', cityId: 'c-newark', city: 'Newark', areaCode: '201', kind: 'local' },
  { regionId: 'r-nj', region: 'New Jersey', cityId: 'c-newark', city: 'Newark', areaCode: '973', kind: 'local' },
  { regionId: 'r-ny', region: 'New York', cityId: 'c-nyc', city: 'New York', areaCode: '212', kind: 'local' },
  { regionId: 'r-ny', region: 'New York', cityId: 'c-li', city: 'Long Island', areaCode: '516', kind: 'local' },
  { regionId: 'r-ny', region: 'New York', cityId: 'c-li', city: 'Long Island', areaCode: '631', kind: 'local' },
  { regionId: 'r-tf', region: 'Toll-free', cityId: 'c-tf', city: 'Toll-free', areaCode: '833', kind: 'toll_free' },
];

/** Numbers per area code: +1 <area> 555 0100 .. 0149. */
const PER_AREA = 50;

export class FakeDidProvider implements DidProvider {
  /** number -> DID id, for numbers we "own". */
  readonly owned = new Map<string, { id: string; trunk: boolean; released: boolean }>();
  readonly orders = new Map<string, { number: string; polls: number }>();
  /** Every call, for tests: ['order', '+1201...'], ['assign', didId], ... */
  readonly calls: [string, string][] = [];
  /** Make every call fail (provider down). */
  down = false;
  /** Orders stay Pending until getOrder() was called this many times. */
  pendingPolls = 0;
  /** Numbers that become unavailable right before they're ordered (someone else bought them). */
  readonly stolen = new Set<string>();
  private seq = 0;

  private check() {
    if (this.down) throw new DidProviderError('fake DID provider down', 503);
  }

  async countries(): Promise<Country[]> {
    this.check();
    return [{ iso: 'US', name: 'United States', prefix: '1' }];
  }

  async regions(country: string): Promise<Place[]> {
    this.check();
    if (country.toUpperCase() !== 'US') return [];
    return uniq(AREAS.map((a) => ({ id: a.regionId, name: a.region })));
  }

  async cities(country: string, regionId?: string): Promise<Place[]> {
    this.check();
    if (country.toUpperCase() !== 'US') return [];
    return uniq(AREAS.filter((a) => !regionId || a.regionId === regionId).map((a) => ({ id: a.cityId, name: a.city })));
  }

  private all(): AvailableNumber[] {
    return AREAS.flatMap((a) =>
      Array.from({ length: PER_AREA }, (_, i) => {
        const number = `+1${a.areaCode}55501${String(i).padStart(2, '0')}`;
        return {
          id: `fake-${number.slice(1)}`,
          number,
          kind: a.kind,
          country: 'US',
          region: a.region,
          city: a.city,
          areaCode: a.areaCode,
          skuId: `sku-${a.kind}`,
        };
      }),
    ).filter((n) => !this.owned.has(n.number));
  }

  async searchAvailable(q: AvailableSearch): Promise<AvailableNumber[]> {
    this.check();
    if (q.country.toUpperCase() !== 'US') return [];
    const areas = AREAS.filter(
      (a) =>
        (!q.regionId || a.regionId === q.regionId) &&
        (!q.cityId || a.cityId === q.cityId) &&
        (!q.areaCode || a.areaCode === q.areaCode) &&
        (!q.kind || a.kind === q.kind),
    ).map((a) => a.areaCode);
    return this.all()
      .filter((n) => areas.includes(n.areaCode!))
      .slice(0, q.limit);
  }

  async getAvailable(id: string): Promise<AvailableNumber | null> {
    this.check();
    return this.all().find((n) => n.id === id) ?? null;
  }

  async order(offer: AvailableNumber): Promise<OrderResult> {
    this.check();
    this.calls.push(['order', offer.number]);
    if (this.stolen.has(offer.number) || this.owned.has(offer.number)) {
      throw new NumberUnavailable(`${offer.number} is no longer available`);
    }
    const orderId = `order-${++this.seq}`;
    this.orders.set(orderId, { number: offer.number, polls: 0 });
    this.owned.set(offer.number, { id: `did-${this.seq}`, trunk: false, released: false });
    return this.pendingPolls > 0 ? { orderId, did: null } : this.result(orderId);
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    this.check();
    const o = this.orders.get(orderId);
    if (!o) throw new DidProviderError(`no order ${orderId}`, 404);
    o.polls++;
    return o.polls >= this.pendingPolls ? this.result(orderId) : { orderId, did: null };
  }

  private result(orderId: string): OrderResult {
    const number = this.orders.get(orderId)!.number;
    return { orderId, did: { id: this.owned.get(number)!.id, number } };
  }

  async findOwnedDid(number: string): Promise<{ id: string; number: string } | null> {
    this.check();
    const d = this.owned.get(number);
    return d ? { id: d.id, number } : null;
  }

  async assignToTrunk(didId: string): Promise<void> {
    this.check();
    this.calls.push(['assign', didId]);
    this.byId(didId).trunk = true;
  }

  async release(didId: string): Promise<void> {
    this.check();
    this.calls.push(['release', didId]);
    this.byId(didId).released = true;
  }

  private byId(didId: string) {
    const d = [...this.owned.values()].find((x) => x.id === didId);
    if (!d) throw new DidProviderError(`no DID ${didId}`, 404);
    return d;
  }
}

const uniq = (places: Place[]): Place[] =>
  [...new Map(places.map((p) => [p.id, p])).values()].sort((a, b) => a.name.localeCompare(b.name));
