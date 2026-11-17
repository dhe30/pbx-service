// What we sell and for how much (course spec §2). Prices are per billing period (7 days) in US
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
// REPRICED (2026-11-13): the course market compares providers' public price lists before signing
// up, and with the old prices ($19 plan with 2 extensions + 100 min, $0.05/min US) no simulated
// customer signed up. The new prices undercut a live competitor (plan $9 / 1 ext / 500 min,
// $0.03/min US) on every item except toll-free numbers, where cost leaves no room. Margins, with
// gateway fees of 2.9% + $0.30 per charge: plan $8.50 nets ~$7.95; its 500 US minutes cost
// $3.00 at the US vendor's $0.006/min (up to $7.50 if every minute went to Alaska at $0.015).

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
export const PLAN = {
  name: 'Business',
  /** Plan price per period. Ceiling: $11.50 per included extension. */
  priceCents: 350,
  includedExtensions: 20,
  /** US outgoing minutes included per period, shared by the account (~$3 at the vendor's rate). */
  includedUsMinutes: 500,
} as const;

export const PRICES = {
  /** Each additional extension, per period. Ceiling $11.50. No direct cost. */
  extensionCents: 25,
  /** Ceiling $3.25. DID provider cost: 0.00 setup + 1.50 per period. */
  localNumberCents: 195,
  /**
   * Ceiling $3.50, and we charge it: the DID provider takes 2.00 setup + 3.00 per 7-day period for
   * a toll-free number (verify-backlog V-D15, 2026-11-11), so 3.00 lost the setup fee and earned
   * nothing on renewal. At 3.50 the setup is recovered in 4 periods. (Local: 0.00 + 1.50 vs 2.75.)
   */
  tollFreeNumberCents: 350,
  /** International calling add-on. Ceiling $4.60. No direct cost. */
  intlCallingCents: 89,
  /** Call recording add-on. Ceiling $4.60. No direct cost (object storage is ours). */
  recordingCents: 89,
} as const;

/** Course ceilings in cents (spec §2), per billing period. */
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
