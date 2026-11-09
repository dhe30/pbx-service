// Time-zone helpers built on Intl (no dependencies). Accounts pick an IANA zone at signup
// (e.g. "America/New_York"); billing periods and business hours are evaluated in it.

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of instant `at` in zone `tz`. */
export function zonedParts(at: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(at)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday!] ?? 0,
  };
}

/** Offset of `tz` from UTC at instant `at`, in ms (New York in winter: -5 h). */
export function tzOffsetMs(at: Date, tz: string): number {
  const p = zonedParts(at, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of local midnight at the start of calendar day y-m-d in `tz` (DST-aware). */
export function zonedMidnight(year: number, month: number, day: number, tz: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  let guess = wall - tzOffsetMs(new Date(wall), tz);
  // Second pass fixes days where the offset at the guess differs (DST change the night before).
  guess = wall - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

/** Calendar date (as a UTC-midnight Date) of `at` in `tz`; used for day arithmetic. */
export function localDate(at: Date, tz: string): { year: number; month: number; day: number } {
  const p = zonedParts(at, tz);
  return { year: p.year, month: p.month, day: p.day };
}

/** Add whole calendar days to a y-m-d date. */
export function addDays(d: { year: number; month: number; day: number }, days: number) {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Whole calendar days from a to b (b - a). */
export function daysBetween(a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function isoDate(d: { year: number; month: number; day: number }): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}
