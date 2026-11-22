// What we sell and for how much. Prices are per billing period (7 days) in US
// cents. Simulated customers' cards decline anything above the course ceilings
// (docs/billing-flows.md §2), so test/billing.test.ts checks every price against them.
//
// DECISION (2026-11-09, open item billing-flows §8.6/8.7, review with the team): the plan
// contents and prices below. Numbers must also cover DIDWW's setup + 7-day renewal fees. Known
// since 2026-11-11 (verify-backlog V-D15): local SKU 0.00 setup + 1.50/period, toll-free 2.00 setup
// + 3.00/period (incoming toll-free minutes cost 0.025, Course Services tab). Toll-free raised to
// its ceiling to cover that; the spec leaves toll-free pricing to us (within the ceilings).
// Per-minute prices are not here: they live in the call_pricing table (what the call path
// charges), and GET /billing/prices reads them from there.
//
// REPRICED (2026-11-13): lower prices (old: $19 plan with 2 extensions + 100 min, $0.05/min US).
// Margins, with gateway fees of 2.9% + $0.30 per charge: plan $8.50 nets ~$7.95; its 500 US
// minutes cost $3.00 at the US vendor's $0.006/min (up to $7.50 if every minute went to Alaska).

// REPRICED (2026-11-15): lower plan, extension, local number and add-on prices, all still above
// cost (extensions, plan and add-ons have no direct cost; local numbers cost 1.50/period). Per-minute
// prices are in migration 20261119000000_price_cut.sql, which also lowers existing customers' items
// to these prices.
// REPRICED (2026-11-17): with usage prepaid, revenue no longer lags costs, so prices only have to
// stay profitable. Cut the items that cost us nothing (included and extra extensions, plan,
// add-ons) and the local number to $0.45 above its cost; US per-minute and international in
// migration 20261121000000_pricing_b.sql. Weekly estimate at 2026-11-17 volume: revenue ~$3.5k,
// costs ~$2.6k (vendors, DID numbers, card fees, VMs), profit ~$0.7k. Existing customers' renewing
// items are lowered to these prices, never raised (same migration).
// REPRICED again (2026-11-18, migration 20261122000000_pricing_c.sql): closer to cost, every
// item still above its direct cost.
// REPRICED (2026-11-22, migration 20261123000000_pricing_d.sql): a standard and an alternate price
// list; the alternate one applies during ALT_WINDOW. An item keeps the price it was bought at
// (renewals never raise it). Per-minute prices are global: the billing scheduler switches the
// call_pricing row (CALL_PRICING below) at the window edges. ALT_PRICING=off disables the
// alternate list (tests).
export interface Plan {
  name: string;
  /** Plan price per period. Ceiling: $11.50 per included extension. */
  priceCents: number;
  includedExtensions: number;
  /** US outgoing minutes included per period, shared by the account. */
  includedUsMinutes: number;
}

export interface ItemPrices {
  /** Each additional extension, per period. Ceiling $11.50. No direct cost. */
  extensionCents: number;
  /** Ceiling $3.25. DID provider cost: 0.00 setup + 1.50 per period. */
  localNumberCents: number;
  /** Ceiling $3.50. DID provider cost: 2.00 setup + 3.00 per period. */
  tollFreeNumberCents: number;
  /** International calling add-on. Ceiling $4.60. No direct cost. */
  intlCallingCents: number;
  /** Call recording add-on. Ceiling $4.60. No direct cost (object storage is ours). */
  recordingCents: number;
}

export const STANDARD_PLAN: Plan = { name: 'Business', priceCents: 289, includedExtensions: 70, includedUsMinutes: 650 };
export const ALT_PLAN: Plan = { name: 'Business', priceCents: 99, includedExtensions: 500, includedUsMinutes: 1000 };

export const STANDARD_PRICES: ItemPrices = {
  extensionCents: 8,
  localNumberCents: 145,
  tollFreeNumberCents: 245,
  intlCallingCents: 55,
  recordingCents: 55,
};
export const ALT_PRICES: ItemPrices = {
  extensionCents: 1,
  localNumberCents: 99,
  tollFreeNumberCents: 199,
  /** Not lower: a prorated purchase under MIN_CHARGE_CENTS is waived and never reaches the card. */
  intlCallingCents: 50,
  recordingCents: 50,
};

/** Per-minute prices (the call_pricing row). Costs: US $0.006/min, incoming toll-free $0.025/min. */
export interface CallPricingSet {
  usPerMin: number;
  tollFreeInPerMin: number;
  intlMultiplier: number;
}
export const CALL_PRICING: { standard: CallPricingSet; alt: CallPricingSet } = {
  standard: { usPerMin: 0.0066, tollFreeInPerMin: 0.012, intlMultiplier: 1.1 },
  alt: { usPerMin: 0.005, tollFreeInPerMin: 0.01, intlMultiplier: 1.0 },
};

/** When the alternate list applies: [startHour, endHour) in timeZone. */
export const ALT_WINDOW = { timeZone: 'America/New_York', startHour: 1, endHour: 6 } as const;

const hourIn = new Intl.DateTimeFormat('en-US', { timeZone: ALT_WINDOW.timeZone, hour: 'numeric', hourCycle: 'h23' });

export const altPricingEnabled = (): boolean => process.env.ALT_PRICING !== 'off';

/** True while the alternate list applies (never with ALT_PRICING=off). */
export function inAltWindow(now: Date = new Date()): boolean {
  if (!altPricingEnabled()) return false;
  const h = Number(hourIn.format(now));
  return h >= ALT_WINDOW.startHour && h < ALT_WINDOW.endHour;
}

export const planAt = (now: Date = new Date()): Plan => (inAltWindow(now) ? ALT_PLAN : STANDARD_PLAN);
export const pricesAt = (now: Date = new Date()): ItemPrices => (inAltWindow(now) ? ALT_PRICES : STANDARD_PRICES);
export const callPricingAt = (now: Date = new Date()): CallPricingSet => (inAltWindow(now) ? CALL_PRICING.alt : CALL_PRICING.standard);

/** The standard list. Code that sells something uses planAt / pricesAt instead. */
export const PLAN = STANDARD_PLAN;
export const PRICES = STANDARD_PRICES;

/** Price ceilings in cents, per billing period. */
export const CEILINGS_CENTS = {
  perIncludedExtension: 1150,
  extension: 1150,
  localNumber: 325,
  tollFreeNumber: 350,
  intlCalling: 460,
  recording: 460,
  /** Prepaid top-up per 10 extensions. */
  topUpPer10Extensions: 2500,
} as const;

/**
 * Prepaid usage (2026-11-17): usage is sold in advance from a credit balance.
 * An account's top-up is `topUpCentsPer10Extensions` times its extensions / 10, rounded up (at
 * least once). It is charged at signup and automatically whenever the balance drops below the
 * threshold, which we set to one top-up (the highest allowed). Calls are never refused for lack of
 * credit. The model applies to every account (tenants.prepaid_since, migration
 * 20261120000000_prepaid_credit.sql).
 *
 * DECISION (2026-11-17): $5 per 10 extensions. Revenue now arrives as usage happens instead of
 * once a week, while the vendors are paid in advance.
 */
export const BILLING_MODEL = 'prepaid' as const;
export const PREPAID = {
  topUpCentsPer10Extensions: 500,
} as const;

/** An account's top-up (and its recharge threshold) for its number of extensions. */
export function topUpCents(extensions: number): number {
  return PREPAID.topUpCentsPer10Extensions * Math.max(1, Math.ceil(extensions / 10));
}

/** Stripe's minimum USD charge. A prorated amount below it is not charged (we waive it). */
export const MIN_CHARGE_CENTS = 50;

/**
 * "Items bought mid-period (including the plan at signup) are charged immediately, prorated
 * linearly to period end." Rounded to the nearest cent, never up past the full price.
 */
export function proratedCents(priceCents: number, period: { start: Date; end: Date }, now: Date): number {
  const total = period.end.getTime() - period.start.getTime();
  const left = Math.min(total, Math.max(0, period.end.getTime() - now.getTime()));
  return Math.min(priceCents, Math.round((priceCents * left) / total));
}
