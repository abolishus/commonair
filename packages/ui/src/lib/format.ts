// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Locale-aware formatting used by the house primitives. Pure functions so the
 * app can format outside React (e.g. document titles) with the same rules.
 * `Intl` formatters are cached because constructing them is comparatively slow
 * and chat/directory views format hundreds of values per render.
 */

import { minorUnits } from "@commonair/contracts/currency";

const cache = new Map<string, Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat>(
  key: string,
  make: () => T,
): T {
  let f = cache.get(key) as T | undefined;
  if (!f) {
    f = make();
    // Bounded: locales x option sets is small in practice, but never let it grow without limit.
    if (cache.size > 500) cache.clear();
    cache.set(key, f);
  }
  return f;
}

export interface FormatMoneyOptions {
  /** `"exceptZero"` for ledger-style +/− amounts. */
  signDisplay?: Intl.NumberFormatOptions["signDisplay"];
  currencyDisplay?: Intl.NumberFormatOptions["currencyDisplay"];
}

/**
 * Formats an integer amount of the currency's minor unit ("cents"; for
 * zero-decimal currencies such as JPY the minor unit is the whole yen).
 * Throws on non-integers: money is never a float in this codebase.
 */
export function formatMoney(cents: number, currency: string, locale: string, options: FormatMoneyOptions = {}): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`formatMoney: cents must be a safe integer, got ${cents}`);
  const code = currency.toUpperCase();
  const digits = minorDigits(code);
  const fmt = cached(
    `money|${locale}|${code}|${options.signDisplay ?? ""}|${options.currencyDisplay ?? ""}`,
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        signDisplay: options.signDisplay ?? "auto",
        currencyDisplay: options.currencyDisplay ?? "symbol",
        // Pin the digits to ISO 4217 so Intl never re-rounds with its own (engine-specific) idea of them.
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }),
  );
  // A decimal string is formatted exactly (Intl.NumberFormat v3); older engines coerce it to a Number, still correct here.
  return fmt.format(toMajorUnits(cents, digits));
}

/**
 * ISO 4217 minor-unit digits (USD 2, JPY 0, KWD 3, HUF 2). From the contracts table, never from
 * `Intl`: V8 and JavaScriptCore disagree for HUF, IDR, IQD and others, which would make server and
 * client render different amounts.
 */
export function minorDigits(currency: string): number {
  return minorUnits(currency);
}

/**
 * Integer minor units to a decimal number for display only. Uses string
 * arithmetic so large amounts never pick up binary-float noise.
 */
function toMajorUnits(cents: number, digits: number): `${number}` {
  if (digits === 0) return `${cents}`;
  const negative = cents < 0;
  const abs = Math.abs(cents)
    .toString()
    .padStart(digits + 1, "0");
  const major = `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  return negative ? (`-${major}` as `${number}`) : (major as `${number}`);
}

/** Micro-units per major unit: unit costs are integer millionths of a dollar/euro/…. */
export const MICROS_PER_UNIT = 1_000_000;

export interface FormatUnitCostOptions extends FormatMoneyOptions {
  /** Most fraction digits shown (default 4; at least the currency's minor digits, at most 6). */
  maximumFractionDigits?: number;
}

/**
 * Formats a sub-minor-unit cost ("$0.0061 per viewer-hour", "$0.466 per 1,000 viewer-hours")
 * from integer micro-units (millionths of the major unit), which cents cannot express. Shows at
 * least the currency's minor digits and up to `maximumFractionDigits` (rounded half-expand by Intl).
 * Throws on non-integers: unit costs are never floats either.
 */
export function formatUnitCost(
  micros: number,
  currency: string,
  locale: string,
  options: FormatUnitCostOptions = {},
): string {
  if (!Number.isSafeInteger(micros))
    throw new RangeError(`formatUnitCost: micros must be a safe integer, got ${micros}`);
  const code = currency.toUpperCase();
  const digits = minorDigits(code);
  const max = Math.min(6, Math.max(digits, Math.trunc(options.maximumFractionDigits ?? 4)));
  const fmt = cached(
    `unit|${locale}|${code}|${max}|${options.signDisplay ?? ""}|${options.currencyDisplay ?? ""}`,
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: code,
        // "negative": a cost that rounds to zero never reads "-$0.00".
        signDisplay: options.signDisplay ?? "negative",
        currencyDisplay: options.currencyDisplay ?? "symbol",
        minimumFractionDigits: digits,
        maximumFractionDigits: max,
      }),
  );
  return fmt.format(toMajorUnits(micros, 6));
}

/** 1234 -> "1.2K" (en), "1234" -> "1234" below 1000, locale-aware. */
export function formatCompactNumber(value: number, locale: string): string {
  const fmt = cached(
    `compact|${locale}`,
    () => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
  );
  return fmt.format(value);
}

/** Full grouping, for screen-reader labels: 1234 -> "1,234". */
export function formatNumber(value: number, locale: string): string {
  return cached(`number|${locale}`, () => new Intl.NumberFormat(locale)).format(value);
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", YEAR],
  ["month", MONTH],
  ["week", WEEK],
  ["day", DAY],
  ["hour", HOUR],
  ["minute", MINUTE],
  ["second", SECOND],
];

/** Future offsets up to this size are treated as "now" (clock skew). */
export const FUTURE_SKEW_MS = 5 * SECOND;

export interface RelativeTimeResult {
  text: string;
  /** Milliseconds until the text would change; `null` when it will not change soon enough to matter. */
  nextUpdateMs: number | null;
}

/**
 * "5 minutes ago" / "in 2 hours" with `numeric: "auto"` ("now", "yesterday").
 * Also returns when the text next changes, so `<RelativeTime>` re-renders exactly then.
 */
export function formatRelativeTime(date: Date, now: number, locale: string): RelativeTimeResult {
  const raw = date.getTime() - now;
  // Small clock skew between server and client must not read "in 3 seconds".
  const diff = raw > 0 && raw <= FUTURE_SKEW_MS ? 0 : raw;
  const abs = Math.abs(diff);
  const fmt = cached(`rel|${locale}`, () => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }));
  const [unit, size] = UNITS.find(([, ms]) => abs >= ms) ?? ["second", SECOND];
  // Truncate (90 s is "1 minute ago"), so unit switches land on whole multiples and never read "60 seconds".
  const value = Math.trunc(diff / size);
  // Truncation yields -0 for the first second in the past; Intl would render "0 seconds ago", not "now".
  const text = fmt.format(value === 0 ? 0 : value, unit);
  if (unit === "year" || unit === "month") return { text, nextUpdateMs: null };
  // The text changes when |diff| crosses the next multiple of the unit: up for past dates, down for future ones.
  const delay = diff <= 0 ? size - (abs % size) : abs % size;
  return { text, nextUpdateMs: Math.max(SECOND, Math.min(delay, DAY)) };
}

/** Absolute timestamp for tooltips and screen readers. */
export function formatDateTime(date: Date, locale: string, timeZone?: string): string {
  return cached(
    `dt|${locale}|${timeZone ?? ""}`,
    () => new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone }),
  ).format(date);
}

const LETTER = /[\p{L}\p{N}]/u;

/**
 * The first letter or digit of a display name as one grapheme (so "Émile" -> "É",
 * flags and combined emoji stay whole), upper-cased for the locale. Falls back to
 * the first grapheme, or "?" for an empty name.
 */
export function getInitial(name: string, locale: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "?";
  const graphemes = Array.from(
    new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(trimmed),
    (s) => s.segment,
  );
  const first = graphemes.find((g) => LETTER.test(g)) ?? graphemes[0] ?? "?";
  return first.toLocaleUpperCase(locale);
}

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** 1_536_000 -> "1.5 MB" (decimal units, as storage and downloads report them), locale-aware. */
export function formatBytes(bytes: number, locale: string): string {
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1000 && index < BYTE_UNITS.length - 1) {
    value /= 1000;
    index++;
  }
  const unit = BYTE_UNITS[index] ?? "byte";
  return cached(
    `bytes|${locale}|${unit}`,
    () =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "short",
        maximumFractionDigits: index === 0 ? 0 : 1,
      }),
  ).format(value);
}

/** A media length as a clock: 75 -> "1:15", 3723 -> "1:02:03". Negative or fractional input floors at 0. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
