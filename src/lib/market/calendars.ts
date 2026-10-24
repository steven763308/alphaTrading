/**
 * Trading sessions, holidays and rollover times. Pure functions; times are UTC ms,
 * local times are computed with Intl (DST-aware).
 *
 * - 24x7: always open (crypto).
 * - fx: Sunday 17:00 → Friday 17:00 America/New_York.
 * - metals: as fx, plus a daily 17:00–18:00 New York maintenance break.
 * - us_equity: NYSE regular session 09:30–16:00 New York, Mon–Fri, excluding NYSE
 *   full-day holidays (rule-based). Early closes (13:00) are not modelled.
 */
import type { CalendarId } from "./catalog";

const partsCache = new Map<string, Intl.DateTimeFormat>();

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0=Sun..6=Sat
  minutes: number; // minutes since local midnight
}

export function localParts(utcMs: number, timeZone: string): LocalParts {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    partsCache.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { year: +p.year, month: +p.month, day: +p.day, weekday: wd, minutes: +p.hour * 60 + +p.minute };
}

// ---------------------------------------------------------------- NYSE holidays

function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

function lastWeekday(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const wd = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((wd - weekday + 7) % 7);
}

/** Gregorian Easter Sunday (Anonymous algorithm). */
function easter(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const key = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Fixed-date holiday observed on Friday if Saturday, Monday if Sunday. */
function observed(year: number, month: number, day: number): string | null {
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const t = Date.UTC(year, month - 1, day) + (wd === 6 ? -1 : wd === 0 ? 1 : 0) * 86_400_000;
  const dt = new Date(t);
  // NYSE does not observe New Year's Day on the prior Friday (Dec 31).
  if (month === 1 && day === 1 && wd === 6) return null;
  return key(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

const holidayCache = new Map<number, Set<string>>();

export function nyseHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const h = new Set<string>();
  const add = (s: string | null) => s && h.add(s);
  add(observed(year, 1, 1));
  add(key(year, 1, nthWeekday(year, 1, 1, 3))); // MLK Day
  add(key(year, 2, nthWeekday(year, 2, 1, 3))); // Presidents' Day
  const e = easter(year);
  const gf = new Date(Date.UTC(year, e.month - 1, e.day) - 2 * 86_400_000);
  add(key(year, gf.getUTCMonth() + 1, gf.getUTCDate())); // Good Friday
  add(key(year, 5, lastWeekday(year, 5, 1))); // Memorial Day
  if (year >= 2022) add(observed(year, 6, 19)); // Juneteenth
  add(observed(year, 7, 4));
  add(key(year, 9, nthWeekday(year, 9, 1, 1))); // Labor Day
  add(key(year, 11, nthWeekday(year, 11, 4, 4))); // Thanksgiving
  add(observed(year, 12, 25));
  holidayCache.set(year, h);
  return h;
}

// ---------------------------------------------------------------- sessions

export interface SessionStatus {
  open: boolean;
  reason: string | null;
}

export function marketStatus(calendar: CalendarId | string, utcMs: number): SessionStatus {
  if (calendar === "24x7") return { open: true, reason: null };
  const ny = localParts(utcMs, "America/New_York");
  if (calendar === "fx" || calendar === "metals") {
    const m = ny.minutes;
    if (ny.weekday === 6) return { open: false, reason: "Weekend (FX closed Friday 17:00 – Sunday 17:00 New York)" };
    if (ny.weekday === 5 && m >= 17 * 60) return { open: false, reason: "Weekend (FX closed Friday 17:00 – Sunday 17:00 New York)" };
    if (ny.weekday === 0 && m < 17 * 60) return { open: false, reason: "Weekend (FX opens Sunday 17:00 New York)" };
    if (calendar === "metals" && m >= 17 * 60 && m < 18 * 60) return { open: false, reason: "Daily metals break 17:00–18:00 New York" };
    if (ny.month === 12 && ny.day === 25) return { open: false, reason: "Christmas Day" };
    if (ny.month === 1 && ny.day === 1 && m < 17 * 60) return { open: false, reason: "New Year's Day" };
    return { open: true, reason: null };
  }
  if (calendar === "us_equity") {
    if (ny.weekday === 0 || ny.weekday === 6) return { open: false, reason: "Weekend (NYSE closed)" };
    if (nyseHolidays(ny.year).has(key(ny.year, ny.month, ny.day))) return { open: false, reason: "NYSE holiday" };
    if (ny.minutes < 9 * 60 + 30) return { open: false, reason: "Pre-market (regular session opens 09:30 New York)" };
    if (ny.minutes >= 16 * 60) return { open: false, reason: "After hours (regular session closed 16:00 New York)" };
    return { open: true, reason: null };
  }
  return { open: true, reason: null };
}

/**
 * Daily rollover instants (17:00 New York) strictly after `from` and at or before `to`,
 * on days the market trades into (Mon–Fri local dates). Returned with a multiplier:
 * 3 on `tripleDay` (weekday number, e.g. 3 = Wednesday) to cover the weekend, else 1.
 */
export function rollovers(from: number, to: number, tripleDay: number | null): { time: number; days: number }[] {
  const out: { time: number; days: number }[] = [];
  if (!(to > from)) return out;
  // Walk hour by hour is wasteful; walk by day starting at the NY date of `from`.
  let t = from - 86_400_000 * 2;
  const end = to + 86_400_000;
  while (t <= end) {
    const p = localParts(t, "America/New_York");
    // UTC instant of 17:00 local on that date: start from UTC guess then correct by offset.
    const guess = Date.UTC(p.year, p.month - 1, p.day, 17, 0);
    const lp = localParts(guess, "America/New_York");
    const offsetMin = lp.minutes - 17 * 60 + (lp.day !== p.day ? (lp.day > p.day ? 1440 : -1440) : 0);
    const instant = guess - offsetMin * 60_000;
    if (instant > from && instant <= to && p.weekday >= 1 && p.weekday <= 5) {
      out.push({ time: instant, days: tripleDay != null && p.weekday === tripleDay ? 3 : 1 });
    }
    t += 86_400_000;
  }
  // Deduplicate (DST transitions can map two walk steps to one date).
  return out.filter((r, i) => i === 0 || r.time !== out[i - 1].time);
}
