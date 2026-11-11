import { DEFAULT_CALL_PRICING, classifyE164, intlRetailPerMin, withRetry, type CallPricing, type Db, type Sql } from '@pbx/shared';

// Per-minute prices by destination (course spec §2: "per-minute rate by destination prefix" shown
// before purchase, on invoices and in the API; docs/telephony-contract.md §7).
//
// The ARI app rates every leg with exactly these rules (services/ari-app/src/pstn.ts + rateLeg()):
//   - US numbers (US vendor, incl. US territories and toll-free): call_pricing.us_per_min, after the
//     plan's included minutes;
//   - everything else, including Canada and the Caribbean (+1 but not US): the international
//     vendor's rate for the longest matching prefix x intl_multiplier, at least intl_min_per_min;
//     no matching prefix = the minimum.
// So the price shown here is the price charged.

export type Region = 'us' | 'intl';

export interface RateRow {
  prefix: string;
  destination: string;
  region: Region;
  /** What we charge, USD per minute (billed in 30/6-second increments). */
  perMin: number;
}

export async function loadPricing(db: Db): Promise<CallPricing> {
  const [p] = await db<{ usPerMin: string; tollFreeInPerMin: string; intlMultiplier: string; intlMinPerMin: string; tollFreeInCostPerMin: string }[]>`
    select us_per_min, toll_free_in_per_min, intl_multiplier, intl_min_per_min, toll_free_in_cost_per_min
      from call_pricing limit 1`;
  if (!p) return DEFAULT_CALL_PRICING;
  // numeric columns arrive as strings
  return {
    usPerMin: Number(p.usPerMin),
    tollFreeInPerMin: Number(p.tollFreeInPerMin),
    intlMultiplier: Number(p.intlMultiplier),
    intlMinPerMin: Number(p.intlMinPerMin),
    tollFreeInCostPerMin: Number(p.tollFreeInCostPerMin),
  };
}

/** Our per-minute price for a vendor-deck row. */
export const retailPerMin = (region: Region, vendorPerMin: number, p: CallPricing): number =>
  region === 'us' ? p.usPerMin : intlRetailPerMin(vendorPerMin, p);

export interface NumberRate {
  number: string;
  region: Region;
  /** Matching rate deck row (longest prefix); null = no row (international: the minimum price applies). */
  prefix: string | null;
  destination: string | null;
  perMin: number;
  /** US calls use the plan's included minutes first. */
  usesIncludedMinutes: boolean;
  /** International calls need the international calling add-on. */
  needsIntlCalling: boolean;
}

/** The price of calling one E.164 number, exactly as the call path rates it. */
export async function rateForNumber(sql: Sql, e164: string): Promise<NumberRate> {
  const region: Region = classifyE164(e164).region;
  const digits = e164.slice(1);
  // Every prefix of the number: an index lookup on rate_decks' primary key (vendor, prefix).
  const prefixes = Array.from({ length: digits.length }, (_, i) => digits.slice(0, i + 1));
  const pricing = await withRetry(() => loadPricing(sql));
  const rows = await withRetry(
    () => sql<{ prefix: string; destination: string; perMin: string }[]>`
      select prefix, destination, per_min from rate_decks
       where vendor = ${region} and prefix = any(${prefixes}::text[])
       order by length(prefix) desc limit 1`,
  );
  const row = rows[0];
  return {
    number: e164,
    region,
    prefix: row?.prefix ?? null,
    destination: row?.destination ?? null,
    perMin: retailPerMin(region, row ? Number(row.perMin) : 0, pricing),
    usesIncludedMinutes: region === 'us',
    needsIntlCalling: region === 'intl',
  };
}

/**
 * A page of the rate deck with our prices, ordered by prefix. `after` = the last prefix of the
 * previous page (keyset paging).
 */
export async function listRates(
  sql: Sql,
  q: { region: Region; prefix?: string; destination?: string; limit: number; after?: string },
): Promise<{ items: RateRow[]; nextCursor: string | null }> {
  const pricing = await withRetry(() => loadPricing(sql));
  const rows = await withRetry(
    () => sql<{ prefix: string; destination: string; perMin: string }[]>`
      select prefix, destination, per_min from rate_decks
       where vendor = ${q.region}
         ${q.prefix ? sql`and prefix like ${q.prefix} || '%'` : sql``}
         ${q.destination ? sql`and destination ilike '%' || ${likeEscape(q.destination)} || '%'` : sql``}
         ${q.after ? sql`and prefix > ${q.after}` : sql``}
       order by prefix
       limit ${q.limit + 1}`,
  );
  const items = rows.slice(0, q.limit).map((r) => ({
    prefix: r.prefix,
    destination: r.destination,
    region: q.region,
    perMin: retailPerMin(q.region, Number(r.perMin), pricing),
  }));
  return { items, nextCursor: rows.length > q.limit ? items.at(-1)!.prefix : null };
}

/** Escapes LIKE wildcards in user input (Postgres' default escape character is a backslash). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, '\\$&');
