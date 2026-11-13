import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALL_PRICING,
  PRICE_CEILINGS,
  PrefixTable,
  billableSeconds,
  billingPeriod,
  classifyE164,
  intlCeilingPerMin,
  intlRetailPerMin,
  isOpen,
  normalizeCarrierNumber,
  normalizeDialed,
  parseRateDeckCsv,
  rateLeg,
  zonedMidnight,
} from '../src/index.js';

describe('§3 Outgoing calls: number formats', () => {
  it('US 10 digits and 1 + 10 digits', () => {
    expect(normalizeDialed('2015550123')).toBe('+12015550123');
    expect(normalizeDialed('12015550123')).toBe('+12015550123');
    expect(normalizeDialed('(201) 555-0123')).toBe('+12015550123');
    expect(normalizeDialed('201.555.0123')).toBe('+12015550123');
  });
  it('any number as E.164 (+) or with 011', () => {
    expect(normalizeDialed('+442071234567')).toBe('+442071234567');
    expect(normalizeDialed('011442071234567')).toBe('+442071234567');
    expect(normalizeDialed('01114165550123')).toBe('+14165550123');
  });
  it('rejects what is not a valid number (extensions are matched before this)', () => {
    expect(normalizeDialed('101')).toBeNull();
    expect(normalizeDialed('*98')).toBeNull();
    expect(normalizeDialed('0123456789')).toBeNull(); // NANP area codes start 2-9
    expect(normalizeDialed('2010550123')).toBeNull(); // exchange starts 2-9
    expect(normalizeDialed('+0123')).toBeNull();
    expect(normalizeDialed('')).toBeNull();
  });
  it('normalizes carrier-delivered numbers (digits without +)', () => {
    expect(normalizeCarrierNumber('12015550123')).toBe('+12015550123');
    expect(normalizeCarrierNumber('2015550123')).toBe('+12015550123');
    expect(normalizeCarrierNumber('442071234567')).toBe('+442071234567');
    expect(normalizeCarrierNumber('anonymous')).toBeNull();
    expect(normalizeCarrierNumber('')).toBeNull();
  });
});

describe('§1 Vendor by destination: US vendor for US, international vendor for everything else incl. non-US +1', () => {
  it('US numbers (incl. territories and toll-free)', () => {
    expect(classifyE164('+12015550123')).toEqual({ region: 'us', tollFree: false });
    expect(classifyE164('+17875550123').region).toBe('us'); // Puerto Rico
    expect(classifyE164('+18005550123')).toEqual({ region: 'us', tollFree: true });
  });
  it('Canada and Caribbean +1 countries are international', () => {
    expect(classifyE164('+14165550123')).toMatchObject({ region: 'intl', nanpCountry: 'CA' });
    expect(classifyE164('+16045550123')).toMatchObject({ region: 'intl', nanpCountry: 'CA' });
    expect(classifyE164('+18765550123')).toMatchObject({ region: 'intl', nanpCountry: 'JM' });
    expect(classifyE164('+18095550123')).toMatchObject({ region: 'intl', nanpCountry: 'DO' });
  });
  it('other country codes are international', () => {
    expect(classifyE164('+442071234567').region).toBe('intl');
    expect(classifyE164('+861012345678').region).toBe('intl');
  });
});

describe('§5 Rating: longest prefix wins', () => {
  const deck = parseRateDeckCsv('prefix,destination,price\n44,United Kingdom,0.02\n447,"United Kingdom, Mobile",0.05\n1,US,0.01\n');
  const t = new PrefixTable(deck);
  it('parses the rate deck CSV (header, quoted fields)', () => {
    expect(deck).toHaveLength(3);
    expect(deck[1]).toEqual({ prefix: '447', destination: 'United Kingdom, Mobile', perMin: 0.05 });
  });
  it('matches the longest prefix', () => {
    expect(t.match('+447700900123')?.prefix).toBe('447');
    expect(t.match('+442071234567')?.prefix).toBe('44');
    expect(t.match('+12015550123')?.prefix).toBe('1');
    expect(t.match('+33123456789')).toBeNull();
  });
});

describe('§5 Bill answered time in 30/6 increments', () => {
  it('30 s minimum, then 6 s steps', () => {
    expect(billableSeconds(0)).toBe(0);
    expect(billableSeconds(1)).toBe(30);
    expect(billableSeconds(30)).toBe(30);
    expect(billableSeconds(31)).toBe(36);
    expect(billableSeconds(36)).toBe(36);
    expect(billableSeconds(37)).toBe(42);
    expect(billableSeconds(95.2)).toBe(96);
  });
});

describe('§2 Prices stay under the ceilings', () => {
  it('defaults are below the per-minute ceilings', () => {
    expect(DEFAULT_CALL_PRICING.usPerMin).toBeLessThanOrEqual(PRICE_CEILINGS.usPerMin);
    expect(DEFAULT_CALL_PRICING.tollFreeInPerMin).toBeLessThanOrEqual(PRICE_CEILINGS.tollFreeInPerMin);
  });
  it('international price <= 6x vendor rate (at least $0.06), and never below cost, for any vendor rate', () => {
    for (const vendor of [0, 0.001, 0.005, 0.01, 0.0123, 0.05, 0.3, 1.7]) {
      expect(intlRetailPerMin(vendor, DEFAULT_CALL_PRICING)).toBeLessThanOrEqual(intlCeilingPerMin(vendor) + 1e-9);
      expect(intlRetailPerMin(vendor, DEFAULT_CALL_PRICING)).toBeGreaterThanOrEqual(DEFAULT_CALL_PRICING.intlMinPerMin);
      expect(intlRetailPerMin(vendor, DEFAULT_CALL_PRICING)).toBeGreaterThan(vendor);
    }
  });
  it('US and incoming toll-free prices stay above what they cost us', () => {
    const usVendorMaxPerMin = 0.015; // us-vendor-rates.csv, 2026-11-13: highest prefix (Alaska)
    expect(DEFAULT_CALL_PRICING.usPerMin).toBeGreaterThan(usVendorMaxPerMin);
    expect(DEFAULT_CALL_PRICING.tollFreeInPerMin).toBeGreaterThan(DEFAULT_CALL_PRICING.tollFreeInCostPerMin);
  });
});

describe('§5 Usage rules per leg', () => {
  const p = DEFAULT_CALL_PRICING;
  it('internal and plain incoming are free', () => {
    expect(rateLeg({ chargeClass: 'internal', answeredSec: 600, costPerMin: 0 }, p, 0).charge).toBe(0);
    expect(rateLeg({ chargeClass: 'incoming', answeredSec: 600, costPerMin: 0 }, p, 0).charge).toBe(0);
  });
  it('US uses included seconds first', () => {
    const r = rateLeg({ chargeClass: 'us', answeredSec: 95, costPerMin: 0.01 }, p, 60);
    expect(r).toMatchObject({ billableSec: 96, includedSec: 60 });
    expect(r.charge).toBeCloseTo((36 * p.usPerMin) / 60, 6);
    expect(r.cost).toBeCloseTo((95 * 0.01) / 60, 6);
  });
  it('international and incoming toll-free never use included minutes', () => {
    expect(rateLeg({ chargeClass: 'intl', answeredSec: 60, costPerMin: 0.02 }, p, 99999).includedSec).toBe(0);
    expect(rateLeg({ chargeClass: 'toll_free_in', answeredSec: 60, costPerMin: 0.025 }, p, 99999).includedSec).toBe(0);
  });
});

describe('§5 Billing period: seven days from midnight (account time zone) on the signup weekday', () => {
  it('starts at local midnight of the signup day and repeats every 7 days', () => {
    const tz = 'America/New_York';
    const signup = new Date('2026-11-04T19:30:00Z'); // Wed 14:30 New York
    const p0 = billingPeriod(tz, signup, signup);
    expect(p0.startDate).toBe('2026-11-04');
    expect(p0.start.toISOString()).toBe('2026-11-04T05:00:00.000Z'); // EST midnight
    expect(p0.end.toISOString()).toBe('2026-11-11T05:00:00.000Z');
    expect(billingPeriod(tz, signup, new Date('2026-11-11T04:59:59Z')).startDate).toBe('2026-11-04');
    expect(billingPeriod(tz, signup, new Date('2026-11-11T05:00:00Z')).startDate).toBe('2026-11-11');
  });
  it('handles the DST change inside a period (period start stays local midnight)', () => {
    const tz = 'America/New_York';
    const signup = new Date('2026-10-28T16:00:00Z'); // Wed, EDT
    const p = billingPeriod(tz, signup, new Date('2026-11-05T12:00:00Z')); // after DST ends (Nov 1)
    expect(p.start.toISOString()).toBe('2026-11-04T05:00:00.000Z'); // EST
    expect(billingPeriod(tz, signup, signup).end.toISOString()).toBe('2026-11-04T05:00:00.000Z');
    expect(zonedMidnight(2026, 10, 28, tz).toISOString()).toBe('2026-10-28T04:00:00.000Z'); // EDT
  });
  it('uses the account time zone, not the server’s', () => {
    const signup = new Date('2026-11-04T23:30:00Z'); // Wed in UTC, still Wed 15:30 in LA, Thu 08:30 in Tokyo
    expect(billingPeriod('America/Los_Angeles', signup, signup).startDate).toBe('2026-11-04');
    expect(billingPeriod('Asia/Tokyo', signup, signup).startDate).toBe('2026-11-05');
  });
});

describe('§3 Business hours in the account time zone', () => {
  const weekdays9to5 = { intervals: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })) };
  it('open on a weekday afternoon, closed in the evening and on weekends', () => {
    const tz = 'America/New_York';
    expect(isOpen(weekdays9to5, tz, new Date('2026-11-04T15:00:00Z'))).toBe(true); // Wed 10:00 EST
    expect(isOpen(weekdays9to5, tz, new Date('2026-11-04T22:30:00Z'))).toBe(false); // Wed 17:30
    expect(isOpen(weekdays9to5, tz, new Date('2026-11-07T15:00:00Z'))).toBe(false); // Sat
    expect(isOpen(weekdays9to5, tz, new Date('2026-11-04T14:00:00Z'))).toBe(true); // 09:00 exactly
    expect(isOpen(weekdays9to5, tz, new Date('2026-11-04T22:00:00Z'))).toBe(false); // 17:00 exactly (end exclusive)
  });
  it('the same instant can be open in one zone and closed in another', () => {
    const at = new Date('2026-11-04T15:00:00Z');
    expect(isOpen(weekdays9to5, 'America/New_York', at)).toBe(true); // 10:00
    expect(isOpen(weekdays9to5, 'America/Los_Angeles', at)).toBe(false); // 07:00
  });
  it('intervals past midnight and 24:00', () => {
    const night = { intervals: [{ day: 5, start: '22:00', end: '02:00' }] }; // Fri 22:00 -> Sat 02:00
    const tz = 'UTC';
    expect(isOpen(night, tz, new Date('2026-11-06T23:00:00Z'))).toBe(true); // Fri 23:00
    expect(isOpen(night, tz, new Date('2026-11-07T01:30:00Z'))).toBe(true); // Sat 01:30
    expect(isOpen(night, tz, new Date('2026-11-07T02:00:00Z'))).toBe(false);
    expect(isOpen({ intervals: [{ day: 3, start: '00:00', end: '24:00' }] }, tz, new Date('2026-11-04T23:59:00Z'))).toBe(true);
  });
});
