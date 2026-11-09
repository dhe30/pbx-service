import { addDays, daysBetween, isoDate, localDate, zonedMidnight } from './tz.js';

// Billing rules from the course spec (Project tab §5), shared by the ARI app (rates every leg as it
// writes the CDR) and the API (invoices, price display). Money is USD as a JS number rounded to
// 6 decimals (the DB stores numeric(12,6)).

/** "Bill answered time in 30/6 increments": first 30 s minimum, then 6 s steps. */
export function billableSeconds(answeredSec: number, firstIncrement = 30, nextIncrement = 6): number {
  if (!(answeredSec > 0)) return 0;
  const s = Math.ceil(answeredSec);
  if (s <= firstIncrement) return firstIncrement;
  return firstIncrement + Math.ceil((s - firstIncrement) / nextIncrement) * nextIncrement;
}

export function roundMoney(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/**
 * Billing period containing `at`: "Seven days from midnight (account time zone) on the signup
 * weekday". Periods are aligned to local midnight of the signup day, every 7 calendar days.
 */
export function billingPeriod(tz: string, signupAt: Date, at: Date): { start: Date; end: Date; startDate: string } {
  const d0 = localDate(signupAt, tz);
  const dAt = localDate(at, tz);
  const k = Math.max(0, Math.floor(daysBetween(d0, dAt) / 7));
  const s = addDays(d0, 7 * k);
  const e = addDays(s, 7);
  return { start: zonedMidnight(s.year, s.month, s.day, tz), end: zonedMidnight(e.year, e.month, e.day, tz), startDate: isoDate(s) };
}

/** Per-minute prices we charge (table call_pricing). Defaults stay under the course ceilings. */
export interface CallPricing {
  /** US outgoing per minute once the plan's included minutes are used. Ceiling $0.06. */
  usPerMin: number;
  /** Incoming toll-free per minute. Ceiling $0.06. */
  tollFreeInPerMin: number;
  /** Other countries: vendor rate x this. Ceiling: 6x vendor rate (at least $0.06). */
  intlMultiplier: number;
  /** Floor for the international per-minute price. */
  intlMinPerMin: number;
  /** What DIDWW charges us per minute on answered incoming toll-free, when the number has no own value. */
  tollFreeInCostPerMin: number;
}

export const DEFAULT_CALL_PRICING: CallPricing = {
  usPerMin: 0.05,
  tollFreeInPerMin: 0.055,
  intlMultiplier: 5,
  intlMinPerMin: 0.06,
  tollFreeInCostPerMin: 0.025,
};

export const PRICE_CEILINGS = {
  usPerMin: 0.06,
  tollFreeInPerMin: 0.06,
  intlMultiplier: 6,
  intlMinPerMin: 0.06,
};

/** Price per minute we charge for an international destination with vendor rate `vendorPerMin`. */
export function intlRetailPerMin(vendorPerMin: number, p: CallPricing): number {
  return roundMoney(Math.max(p.intlMinPerMin, vendorPerMin * p.intlMultiplier));
}

/** The course ceiling for an international destination (6x vendor rate, at least $0.06). */
export function intlCeilingPerMin(vendorPerMin: number): number {
  return Math.max(PRICE_CEILINGS.intlMinPerMin, vendorPerMin * PRICE_CEILINGS.intlMultiplier);
}

/**
 * How a leg is billed:
 *  internal     : extension to extension, voicemail, IVR. Free.
 *  incoming     : non-toll-free incoming. Free.
 *  toll_free_in : incoming on a toll-free number. Always per minute.
 *  us           : leg we place to a US number. Uses the plan's shared included minutes first.
 *  intl         : leg we place outside the US (incl. other +1 countries). Always per minute.
 */
export type ChargeClass = 'internal' | 'incoming' | 'toll_free_in' | 'us' | 'intl';

export interface LegToRate {
  chargeClass: ChargeClass;
  /** Answered seconds (vendors charge us per second of this). */
  answeredSec: number;
  /** Vendor rate deck price per minute (us/intl), or DIDWW toll-free cost (toll_free_in). */
  costPerMin: number;
}

export interface RatedLeg {
  billableSec: number;
  cost: number;
  charge: number;
  /** Included US seconds consumed by this leg. */
  includedSec: number;
}

/** Rate one leg. `includedRemainingSec` = plan US seconds still unused this period. */
export function rateLeg(leg: LegToRate, pricing: CallPricing, includedRemainingSec: number): RatedLeg {
  const answered = Math.max(0, Math.ceil(leg.answeredSec));
  if (answered === 0) return { billableSec: 0, cost: 0, charge: 0, includedSec: 0 };
  const billable = billableSeconds(answered);
  const cost = roundMoney((leg.costPerMin * answered) / 60);
  switch (leg.chargeClass) {
    case 'internal':
    case 'incoming':
      return { billableSec: billable, cost: 0, charge: 0, includedSec: 0 };
    case 'toll_free_in':
      return { billableSec: billable, cost, charge: roundMoney((billable * pricing.tollFreeInPerMin) / 60), includedSec: 0 };
    case 'us': {
      const included = Math.max(0, Math.min(billable, Math.floor(includedRemainingSec)));
      return { billableSec: billable, cost, charge: roundMoney(((billable - included) * pricing.usPerMin) / 60), includedSec: included };
    }
    case 'intl':
      return {
        billableSec: billable,
        cost,
        charge: roundMoney((billable * intlRetailPerMin(leg.costPerMin, pricing)) / 60),
        includedSec: 0,
      };
  }
}

/** Longest-prefix rate table (rate decks: "prefix, destination, price per minute; longest prefix wins"). */
export interface RateRow {
  prefix: string;
  destination: string;
  perMin: number;
}

export class PrefixTable {
  private readonly byPrefix = new Map<string, RateRow>();
  private maxLen = 0;

  constructor(rows: Iterable<RateRow>) {
    for (const r of rows) {
      const p = r.prefix.replace(/^\+/, '');
      if (!/^[0-9]+$/.test(p)) continue;
      this.byPrefix.set(p, { ...r, prefix: p });
      this.maxLen = Math.max(this.maxLen, p.length);
    }
  }

  get size(): number {
    return this.byPrefix.size;
  }

  /** Best (longest) matching row for an E.164 number (with or without '+'), or null. */
  match(number: string): RateRow | null {
    const digits = number.replace(/^\+/, '');
    for (let len = Math.min(this.maxLen, digits.length); len > 0; len--) {
      const row = this.byPrefix.get(digits.slice(0, len));
      if (row) return row;
    }
    return null;
  }
}

/** Parse a rate deck CSV ("prefix,destination,price"; header optional; quoted fields allowed). */
export function parseRateDeckCsv(text: string): RateRow[] {
  const rows: RateRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (cells.length < 3) continue;
    const prefix = cells[0]!.replace(/^\+/, '').trim();
    const perMin = Number(cells[cells.length - 1]!.replace(/^\$/, ''));
    if (!/^[0-9]+$/.test(prefix) || !Number.isFinite(perMin)) continue; // header or junk
    rows.push({ prefix, destination: cells.slice(1, -1).join(',').trim(), perMin });
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
