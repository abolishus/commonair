// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rules behind the shared date and time field (F33, `date-time-field.tsx`): the general form
 * of D4's birth-date field (`lib/birth-date.ts` keeps the date rules) plus an hour and a minute.
 * Pure. Two value shapes, one per kind of caller: parts (crew's split window, which needs to tell
 * "incomplete" from "empty") and the `YYYY-MM-DDTHH:MM` text the old `datetime-local` input
 * produced (egress, the legal queue), which the pages parse as before.
 */
import { daysInMonth, type DatePart } from "../../lib/birth-date.ts";

export type DateTimePart = DatePart | "hour" | "minute";

/** Each part, null until chosen. Hour 0–23, minute 0–59. */
export type DateTimeParts = Record<DateTimePart, number | null>;

export const EMPTY_DATE_TIME: DateTimeParts = { day: null, month: null, year: null, hour: null, minute: null };

export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/**
 * The minutes the minute select offers: every `step` minutes from :00. A step that does not
 * divide the hour (7, 0, 1.5) is a bug in the caller and throws.
 */
export function minuteOptions(step: number): number[] {
  if (!Number.isInteger(step) || step < 1 || 60 % step !== 0)
    throw new RangeError(`minuteOptions: step must divide 60, got ${step}`);
  return Array.from({ length: 60 / step }, (_, i) => i * step);
}

/**
 * The list with `n` in it, in the list's own order (newest-first year lists stay newest first): a
 * value from outside the offered range (an old egress window from the URL, a minute off the step)
 * must still show rather than the placeholder.
 */
export function withOption(list: readonly number[], n: number | null): readonly number[] {
  if (n === null || list.includes(n)) return list;
  const first = list[0];
  const last = list[list.length - 1];
  const ascending = first !== undefined && last !== undefined && first < last;
  return [...list, n].sort((a, b) => (ascending ? a - b : b - a));
}

/** Years to offer, newest first: `before` years back to `after` years ahead of `now`'s (UTC) year. */
export function dateTimeYears(now: Date, before = 2, after = 0): number[] {
  const current = now.getUTCFullYear();
  return Array.from({ length: before + after + 1 }, (_, i) => current + after - i);
}

/** Years to offer, oldest first: this year and the next `ahead` (a split window is in the future). */
export function upcomingYears(now: Date, ahead = 5): number[] {
  const current = now.getFullYear();
  return Array.from({ length: ahead + 1 }, (_, i) => current + i);
}

/** Whether nothing at all is chosen (an optional field left empty). */
export function isEmptyDateTime(parts: DateTimeParts): boolean {
  return Object.values(parts).every((v) => v === null);
}

/** The days the chosen month has; a leap year stands in until a year is chosen, so February offers 29. */
export function maxDay(parts: Pick<DateTimeParts, "year" | "month">): number {
  return parts.month ? daysInMonth(parts.year || 2000, parts.month) : 31;
}

/**
 * `parts` with one part set. A day the new month or year does not have (31, then February) becomes
 * that month's last day, so the field never holds a date it cannot show.
 */
export function withPart(parts: DateTimeParts, part: DateTimePart, n: number): DateTimeParts {
  const next = { ...parts, [part]: n };
  const max = maxDay(next);
  return next.day !== null && next.day > max ? { ...next, day: max } : next;
}

export type DateTimeResult = { iso: string } | { empty: true } | { error: "incomplete" | "invalid" };

/**
 * The instant the parts name in the browser's time zone, as ISO; `empty` when nothing is chosen;
 * `incomplete` when only part of the date is (an unchosen hour or minute reads as 0); `invalid`
 * for a day the month does not have.
 */
export function dateTimeIso(parts: DateTimeParts): DateTimeResult {
  if (isEmptyDateTime(parts)) return { empty: true };
  const { day, month, year } = parts;
  if (!day || !month || !year) return { error: "incomplete" };
  if (day > daysInMonth(year, month)) return { error: "invalid" };
  const date = new Date(year, month - 1, day, parts.hour ?? 0, parts.minute ?? 0, 0, 0);
  if (Number.isNaN(date.getTime())) return { error: "invalid" };
  return { iso: date.toISOString() };
}

const TEXT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/** The parts of a `YYYY-MM-DDTHH:MM` value (seconds ignored); all null for anything else. */
export function dateTimeParts(value: string): DateTimeParts {
  const m = TEXT.exec(value.trim());
  if (!m) return { ...EMPTY_DATE_TIME };
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]) };
}

/** `YYYY-MM-DDTHH:MM` for complete parts (the day clamped to the month), or "". */
export function dateTimeValue(parts: DateTimeParts): string {
  const { year, month, day, hour, minute } = parts;
  if (year === null || month === null || day === null || hour === null || minute === null) return "";
  const d = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(d)}T${pad2(hour)}:${pad2(minute)}`;
}

/** Two-digit text for minutes (":05") and the text value; hours are labelled with `formatHour`. */
export const pad2 = (n: number): string => String(n).padStart(2, "0");
