// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sign-up date of birth as three selects (F17): the order the locale writes dates in, and the
 * same rules as the native date input it replaces. The age rule itself is the API's (it answers
 * with an error code the form shows); the client only refuses a missing, impossible or future date.
 */
import { formatDateTime } from "@commonair/ui";

export type DatePart = "day" | "month" | "year";

export interface DateParts {
  /** 0 = not chosen. */
  day: number;
  /** 1–12; 0 = not chosen. */
  month: number;
  /** 0 = not chosen. */
  year: number;
}

export const EMPTY_DATE: DateParts = { day: 0, month: 0, year: 0 };

const DEFAULT_ORDER: readonly DatePart[] = ["month", "day", "year"];
/** 22 November 2001 at noon UTC: a day, a month and a year that cannot be mistaken for each other. */
const PROBE = new Date(Date.UTC(2001, 10, 22, 12));

/**
 * The order of day, month and year in the locale's long date ("November 22, 2001" → month, day,
 * year; "22 de noviembre de 2001" → day, month, year; "2001年11月22日" → year, month, day).
 * Falls back to month, day, year when the formatted date does not show the probe's digits.
 */
export function dateFieldOrder(locale: string, monthName: string): DatePart[] {
  let text: string;
  try {
    text = formatDateTime(PROBE, locale, "UTC");
  } catch {
    return [...DEFAULT_ORDER];
  }
  const at: Record<DatePart, number> = {
    year: text.indexOf("2001"),
    day: text.indexOf("22"),
    month: monthName ? text.toLocaleLowerCase(locale).indexOf(monthName.toLocaleLowerCase(locale)) : -1,
  };
  if (at.month < 0) at.month = text.indexOf("11");
  if (at.year < 0 || at.day < 0 || at.month < 0) return [...DEFAULT_ORDER];
  return (["day", "month", "year"] as const).slice().sort((a, b) => at[a] - at[b]);
}

/** Years to offer, newest first: this year back 120 years (the API checks the minimum age). */
export function birthYears(now: Date, span = 120): number[] {
  const current = now.getUTCFullYear();
  return Array.from({ length: span + 1 }, (_, i) => current - i);
}

/** Days in a month (1–12) of a year; 31 until both are chosen. */
export function daysInMonth(year: number, month: number): number {
  if (!year || !month) return 31;
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The parts of a `YYYY-MM-DD` string (the form's `birthDate` value); empty for anything else. */
export function partsFromIso(value: string): DateParts {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return { ...EMPTY_DATE };
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** The form value for complete parts (`YYYY-MM-DD`, not checked), or "". */
export function isoFromParts(parts: DateParts): string {
  if (!parts.day || !parts.month || !parts.year) return "";
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

export type BirthDateResult = { iso: string } | { error: "required" | "invalid" | "future" };

/** `YYYY-MM-DD` for complete, real, not-future parts; otherwise why not. */
export function validateBirthDate(parts: DateParts, now: Date): BirthDateResult {
  const { day, month, year } = parts;
  if (!day || !month || !year) return { error: "required" };
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return { error: "invalid" };
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (date.getTime() > today) return { error: "future" };
  return { iso: date.toISOString().slice(0, 10) };
}
