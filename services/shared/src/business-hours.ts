import type { WeeklySchedule } from './ivr-config.js';
import { zonedParts } from './tz.js';

// "Business hours. Weekly schedule in the account's time zone; open and closed destinations."

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}

/** True if `at` falls inside an opening interval of `schedule`, evaluated in `tz`. */
export function isOpen(schedule: WeeklySchedule, tz: string, at: Date): boolean {
  const p = zonedParts(at, tz);
  const now = p.hour * 60 + p.minute;
  const yesterday = (p.weekday + 6) % 7;
  for (const iv of schedule.intervals) {
    const start = minutes(iv.start);
    const end = minutes(iv.end);
    if (end > start) {
      if (iv.day === p.weekday && now >= start && now < end) return true;
    } else {
      // Runs past midnight: [start, 24:00) on `day` and [00:00, end) on the next day.
      if (iv.day === p.weekday && now >= start) return true;
      if (iv.day === yesterday && now < end) return true;
    }
  }
  return false;
}
