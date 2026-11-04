// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Locale-aware formatting used by the house primitives. Pure functions so the
 * app can format outside React (e.g. document titles) with the same rules.
 * `Intl` formatters are cached because constructing them is comparatively slow
 * and chat/directory views format hundreds of values per render.
 */

import { minorUnits } from "@commonair/contracts/currency";

const cache = new Map<string, Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat | Intl.DisplayNames>();

function cached<T extends Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat | Intl.DisplayNames>(
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

/**
 * A language's name for a locale switcher: `formatLanguageName("es")` -> "Español" (its own
 * name), `formatLanguageName("es", "en")` -> "Spanish". The first letter is upper-cased for the
 * display locale, as a menu item starts; an unknown or malformed tag comes back as given.
 */
export function formatLanguageName(tag: string, displayLocale: string = tag): string {
  let name: string | undefined;
  try {
    name = cached(`lang|${displayLocale}`, () => new Intl.DisplayNames([displayLocale], { type: "language" })).of(tag);
  } catch {
    return tag;
  }
  // Unknown languages come back as the canonical tag ("zz-zz" -> "zz-ZZ"): not a name.
  if (!name || name === tag || name === Intl.getCanonicalLocales(tag)[0]) return tag;
  const [first = "", ...rest] = Array.from(name);
  return first.toLocaleUpperCase(displayLocale) + rest.join("");
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
  // Intl's short "byte" reads "0 byte"; below a kilobyte use the symbol, as every larger unit does.
  if (index === 0) return `${formatNumber(Math.round(value), locale)} B`;
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

/** Shown for a number that cannot be formatted (`NaN`): a dash reads as "no value" in every locale. */
export const NO_VALUE = "—";

function clampDigits(digits: number): number {
  // NaN or ±Infinity would make Intl throw a RangeError; treat them as 0.
  return Number.isFinite(digits) ? Math.min(20, Math.max(0, Math.trunc(digits))) : 0;
}

export interface FormatPercentOptions {
  minimumFractionDigits?: number;
  /** Default 0, raised to `minimumFractionDigits` when that is larger. */
  maximumFractionDigits?: number;
}

/** A share as a percentage, `value` a fraction: 0.125 -> "12.5%" (en), "12,5 %" (es, de). `NaN` -> `NO_VALUE`. */
export function formatPercent(value: number, locale: string, options: FormatPercentOptions = {}): string {
  if (Number.isNaN(value)) return NO_VALUE;
  const min = clampDigits(options.minimumFractionDigits ?? 0);
  const max = Math.max(min, clampDigits(options.maximumFractionDigits ?? 0));
  return cached(
    `percent|${locale}|${min}|${max}`,
    () => new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: min, maximumFractionDigits: max }),
  ).format(value);
}

/** A count with grouping, rounded to a whole number: 1234.5 -> "1,235" (en), "1.235" (es, de). `NaN` -> `NO_VALUE`. */
export function formatInteger(value: number, locale: string): string {
  if (Number.isNaN(value)) return NO_VALUE;
  return cached(`integer|${locale}`, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })).format(value);
}

export interface FormatUnitOptions {
  minimumFractionDigits?: number;
  /** Default 3, raised to `minimumFractionDigits` when that is larger. */
  maximumFractionDigits?: number;
  unitDisplay?: "short" | "long" | "narrow";
}

/**
 * A measurement in one of `Intl`'s sanctioned units ("kilobyte", "second", …):
 * `formatUnit(1.5, "kilobyte", "en")` -> "1.5 kB". `NaN` -> `NO_VALUE`.
 */
export function formatUnit(value: number, unit: string, locale: string, options: FormatUnitOptions = {}): string {
  if (Number.isNaN(value)) return NO_VALUE;
  const min = clampDigits(options.minimumFractionDigits ?? 0);
  const max = Math.max(min, clampDigits(options.maximumFractionDigits ?? 3));
  const display = options.unitDisplay ?? "short";
  return cached(
    `unit|${locale}|${unit}|${display}|${min}|${max}`,
    () =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: display,
        minimumFractionDigits: min,
        maximumFractionDigits: max,
      }),
  ).format(value);
}

/**
 * The twelve month names for a date picker, January first: "January" (en), "enero" (es),
 * "Januar" (de).
 */
export function monthNames(locale: string, width: "long" | "short" = "long"): string[] {
  const fmt = cached(
    `month|${locale}|${width}`,
    () => new Intl.DateTimeFormat(locale, { month: width, timeZone: "UTC" }),
  );
  return Array.from({ length: 12 }, (_, index) => fmt.format(new Date(Date.UTC(2020, index, 1))));
}

export interface NumberSeparators {
  decimal: string;
  /** The grouping separator; `""` for a locale that never groups. */
  group: string;
}

/** The locale's decimal and grouping separators: en "." and ",", de "," and ".", fr "," and a narrow no-break space. */
export function numberSeparators(locale: string): NumberSeparators {
  const parts = cached(`number|${locale}`, () => new Intl.NumberFormat(locale)).formatToParts(12345.6);
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    group: parts.find((part) => part.type === "group")?.value ?? "",
  };
}

/** The currency's symbol in the locale: USD -> "$" (en), "US$" (es); falls back to the code. */
export function currencySymbol(currency: string, locale: string): string {
  const code = currency.toUpperCase();
  const parts = cached(
    `symbol|${locale}|${code}`,
    () => new Intl.NumberFormat(locale, { style: "currency", currency: code }),
  ).formatToParts(0);
  return parts.find((part) => part.type === "currency")?.value ?? code;
}

/**
 * Text typed into an amount field -> integer minor units, or `null` when it is not an amount
 * (empty, negative, non-numeric, ambiguous, more decimals than the currency has, beyond a safe
 * integer). Reads the locale's separators ("1.234,5" in de); where the group separator is a space
 * of some kind, any whitespace is accepted. The group separator is only dropped where it groups
 * thousands correctly ("1.234", "12.345.678"), so a misplaced one is rejected, never deleted.
 * With no locale decimal present, a lone "." or "," followed by at most the currency's minor
 * digits is read as the decimal: "12.50" in es is $12.50, not $1,250 (people type the other
 * convention). Integer arithmetic only, so "1.005" never rounds through a float.
 */
export function parseAmountInput(text: string, currency: string, locale: string): number | null {
  const { decimal, group } = numberSeparators(locale);
  const digits = minorDigits(currency.toUpperCase());
  const spaceGroup = /^\s$/u.test(group);
  const normalized = spaceGroup ? text.replace(/\s/gu, "") : text.trim();
  let whole: string;
  let fraction = "";
  const pieces = normalized.split(decimal);
  if (pieces.length > 2) return null;
  if (pieces.length === 2) {
    [whole = "", fraction = ""] = pieces;
  } else {
    whole = normalized;
    const other = /^(\d+)([.,])(\d+)$/.exec(normalized);
    const [, head = "", mark = "", tail = ""] = other ?? [];
    const isGrouping = mark === group && tail.length === 3;
    if (other && !isGrouping && tail.length <= digits) [whole, fraction] = [head, tail];
  }
  if (group && !spaceGroup && whole.includes(group)) {
    const escaped = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^\\d{1,3}(?:${escaped}\\d{3})+$`, "u").test(whole)) return null;
    whole = whole.split(group).join("");
  }
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || whole + fraction === "") return null;
  if (fraction.length > digits) return null;
  const amount = Number(whole || "0") * 10 ** digits + Number((fraction + "0".repeat(digits)).slice(0, digits) || 0);
  return Number.isSafeInteger(amount) ? amount : null;
}

/**
 * Integer minor units -> the text an amount field shows: 123456 USD -> "1234.56" (en),
 * "1234,56" (de); no grouping and no symbol, so `parseAmountInput` reads it back. A value that
 * is not a safe integer shows as empty.
 */
export function formatAmountInput(cents: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(cents)) return "";
  const digits = minorDigits(currency.toUpperCase());
  return cached(
    `input|${locale}|${digits}`,
    () =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
        useGrouping: false,
      }),
  ).format(toMajorUnits(cents, digits));
}
