// The DID provider (course "DID provider": a DIDWW API v3 clone, CLAUDE.md §3 A6) as the API sees
// it. Two implementations: HttpDidwwProvider (src/numbers/didww.ts) for the real service, and
// FakeDidProvider (src/numbers/fake-provider.ts) for tests and local dev (DID_PROVIDER_MODE=fake).
// The purchase flow (src/numbers/purchase.ts) only uses this interface.

export type NumberKind = 'local' | 'toll_free';

export interface Place {
  /** Provider id (DIDWW region / city id). */
  id: string;
  name: string;
}

export interface Country {
  /** ISO 3166-1 alpha-2, e.g. "US". */
  iso: string;
  name: string;
  /** Calling code without "+", e.g. "1". */
  prefix: string;
}

export interface AvailableSearch {
  /** ISO country code. */
  country: string;
  regionId?: string;
  cityId?: string;
  /** National area code, e.g. "201" (DIDWW did_group prefix). */
  areaCode?: string;
  kind?: NumberKind;
  limit: number;
}

export interface AvailableNumber {
  /** Provider id of this offer (DIDWW available_did id); what POST /numbers/purchase takes. */
  id: string;
  /** E.164 with "+". */
  number: string;
  kind: NumberKind;
  country: string;
  region: string | null;
  city: string | null;
  areaCode: string | null;
  /** Provider-side product to order (DIDWW stock keeping unit id). */
  skuId: string;
}

export interface OrderResult {
  orderId: string;
  /** The ordered DID, once the order completed; null while the provider is still processing it. */
  did: { id: string; number: string } | null;
}

export interface DidProvider {
  countries(): Promise<Country[]>;
  regions(country: string): Promise<Place[]>;
  cities(country: string, regionId?: string): Promise<Place[]>;
  searchAvailable(q: AvailableSearch): Promise<AvailableNumber[]>;
  /** One offer by id; null if it's gone (bought by someone else or never existed). */
  getAvailable(id: string): Promise<AvailableNumber | null>;
  /**
   * Orders an offer. Throws NumberUnavailable if it was taken meanwhile. The caller makes this
   * safe to retry: before ordering again after an interrupted attempt it asks findOwnedDid().
   */
  order(offer: AvailableNumber): Promise<OrderResult>;
  /** Status of an earlier order (to finish one that was still processing). */
  getOrder(orderId: string): Promise<OrderResult>;
  /** The DID with this E.164 number if it is already in our provider account, else null. */
  findOwnedDid(number: string): Promise<{ id: string; number: string } | null>;
  /** Points the DID at our inbound trunk (or trunk group), so its calls reach our edges. */
  assignToTrunk(didId: string): Promise<void>;
  /** Stops renewing the DID: it keeps working until the end of its paid cycle, then lapses. */
  release(didId: string): Promise<void>;
}

/** The provider failed or answered something unexpected (-> 502, safe to retry). */
export class DidProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** The offer was taken or doesn't exist (-> 409 number_unavailable). */
export class NumberUnavailable extends Error {}
