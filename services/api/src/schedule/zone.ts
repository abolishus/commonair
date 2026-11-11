// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Wall-clock arithmetic in an IANA time zone, on `Intl.DateTimeFormat` alone (no dependency).
 * `localToInstant` resolves a wall time the way Temporal's "compatible" disambiguation does: in a
 * spring-forward gap the time moves forward by the gap (02:30 → 03:30), in a fall-back overlap the
 * earlier of the two instants wins. Pure, unit-tested.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A calendar date with no zone: `month` is 1–12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Whether the runtime knows `timeZone` as an IANA name (not an offset such as "+01:00"). */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone)) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at `instantMs`, as the UTC milliseconds of the same wall time. */
function wallMs(timeZone: string, instantMs: number): number {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const p of formatter(timeZone).formatToParts(instantMs))
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** The zone's UTC offset at `instantMs`, in milliseconds (Toronto in winter: −5 h). */
export function offsetMs(timeZone: string, instantMs: number): number {
  // Whole seconds: the formatter drops the milliseconds.
  const whole = Math.floor(instantMs / 1000) * 1000;
  return wallMs(timeZone, whole) - whole;
}

/** The local calendar date in `timeZone` at `instantMs`. */
export function localDateOf(timeZone: string, instantMs: number): LocalDate {
  const d = new Date(wallMs(timeZone, instantMs));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** `date` moved by `days` (any sign), across months and years. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  const js = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return js === 0 ? 7 : js;
}

/** Minutes after midnight of "HH:MM" (or "HH:MM:SS", as Postgres prints `time`). */
export function minutesOf(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) throw new RangeError(`not a local time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** The instant (ms) of a wall time, `minutes` after local midnight of `date`, in `timeZone`. */
export function localToInstant(timeZone: string, date: LocalDate, minutes: number): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day) + minutes * MINUTE_MS;
  // At most one transition sits within a day of any wall time, so the offsets a day either side
  // are the only candidates.
  const before = offsetMs(timeZone, wall - DAY_MS);
  const after = offsetMs(timeZone, wall + DAY_MS);
  const candidates = [...new Set([wall - before, wall - after])].filter(
    (instant) => instant + offsetMs(timeZone, instant) === wall,
  );
  // Overlap: both are real and the earlier wins. Gap: neither is, and the offset from before the
  // transition moves the time forward by the gap.
  return candidates.length > 0 ? Math.min(...candidates) : wall - before;
}
