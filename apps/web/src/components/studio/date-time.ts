// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A local date and time as design-system selects (F33): the general form of D4's birth-date field
 * (`lib/birth-date.ts` keeps the date rules), plus an hour and a minute. Used instead of the
 * browser's `datetime-local`, which looks and reads differently in every browser. Pure.
 */
import { daysInMonth, type DateParts } from "../../lib/birth-date.ts";

export interface DateTimeParts extends DateParts {
  /** 0–23; null = not chosen (midnight once a date is chosen). */
  hour: number | null;
  /** 0–59; null = not chosen (:00). */
  minute: number | null;
}

export const EMPTY_DATE_TIME: DateTimeParts = { day: 0, month: 0, year: 0, hour: null, minute: null };

/** The minutes the minute select offers. */
export const MINUTE_STEP = 5;
export const MINUTES: readonly number[] = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, i) => i);

/** Years to offer, oldest first: this year and the next `ahead` (a split window is in the future). */
export function upcomingYears(now: Date, ahead = 5): number[] {
  const current = now.getFullYear();
  return Array.from({ length: ahead + 1 }, (_, i) => current + i);
}

/** Whether nothing at all is chosen (an optional field left empty). */
export function isEmptyDateTime(parts: DateTimeParts): boolean {
  return !parts.day && !parts.month && !parts.year && parts.hour === null && parts.minute === null;
}

export type DateTimeResult = { iso: string } | { empty: true } | { error: "incomplete" | "invalid" };

/**
 * The instant the parts name in the browser's time zone, as ISO; `empty` when nothing is chosen;
 * `incomplete` when only part of the date is; `invalid` for a day the month does not have.
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

/** The days the chosen month has; a leap year stands in until a year is chosen, so February offers 29. */
export function maxDay(parts: Pick<DateTimeParts, "year" | "month">): number {
  return parts.month ? daysInMonth(parts.year || 2000, parts.month) : 31;
}

/**
 * `parts` with one part set. A day the new month or year does not have (31, then February) becomes
 * that month's last day, so the field never holds a date it cannot show.
 */
export function withPart(parts: DateTimeParts, part: keyof DateTimeParts, n: number): DateTimeParts {
  const next = { ...parts, [part]: n };
  const max = maxDay(next);
  return next.day > max ? { ...next, day: max } : next;
}

/**
 * Two-digit clock text for the hour and minute selects ("07", "30"). The hours stay on a 24-hour
 * clock until `@commonair/ui` has a shared hour formatter (inline `Intl` is against the source policy).
 */
export const pad2 = (n: number): string => String(n).padStart(2, "0");
