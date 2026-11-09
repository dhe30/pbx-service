// What we sell and for how much (course spec §2). Prices are per billing period (7 days) in US
// cents. Simulated customers' cards decline anything above the course ceilings
// (docs/billing-flows.md §2), so test/billing.test.ts checks every price against them.
//
// DECISION (2026-11-09, open item billing-flows §8.6/8.7, review with the team): the plan
// contents and prices below. Numbers must also cover DIDWW's setup + 7-day renewal fees, which
// are not known yet: re-check them against the DIDWW API before the grading window.
// Per-minute prices are not here: they live in the call_pricing table (what the call path
// charges), and GET /billing/prices reads them from there.

export const PLAN = {
  name: 'Business',
  /** Plan price per period. Ceiling: $11.50 per included extension. */
  priceCents: 1900,
  includedExtensions: 2,
  /** US outgoing minutes included per period, shared by the account. */
  includedUsMinutes: 100,
} as const;

export const PRICES = {
  /** Each additional extension, per period. Ceiling $11.50. */
  extensionCents: 900,
  /** Ceiling $3.25. */
  localNumberCents: 275,
  /** Ceiling $3.50. */
  tollFreeNumberCents: 300,
  /** International calling add-on. Ceiling $4.60. */
  intlCallingCents: 390,
  /** Call recording add-on. Ceiling $4.60. */
  recordingCents: 390,
} as const;

/** Course ceilings in cents (spec §2), per billing period. */
export const CEILINGS_CENTS = {
  perIncludedExtension: 1150,
  extension: 1150,
  localNumber: 325,
  tollFreeNumber: 350,
  intlCalling: 460,
  recording: 460,
} as const;

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
