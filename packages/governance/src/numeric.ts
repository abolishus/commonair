// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact emulation of the Postgres `numeric` comparisons the SQL tally performs:
 * `count::numeric / count < threshold::numeric`. Floating point would disagree with
 * the database at exact boundaries (2/3, 1/2), so the quotient is computed the way
 * Postgres does it: rounded half away from zero at the scale `select_div_scale`
 * picks, then compared exactly with the threshold's decimal text (the JSON number
 * stored in the frozen rules).
 */

/** A non-negative decimal `units / 10^scale`. */
export interface Decimal {
  units: bigint;
  scale: number;
}

const NBASE = 10_000n;
const DEC_DIGITS = 4;
const NUMERIC_MIN_SIG_DIGITS = 16;
const NUMERIC_MAX_DISPLAY_SCALE = 1000;

/** Weight (index of the leading base-10000 digit) and that leading digit of a positive integer. */
function leading(n: bigint): { weight: number; first: bigint } {
  let weight = 0;
  let first = n;
  while (first >= NBASE) {
    first /= NBASE;
    weight++;
  }
  return { weight, first };
}

/** Result scale Postgres chooses for `a::numeric / b` with integer operands (dscale 0). */
export function pgDivScale(a: bigint, b: bigint): number {
  const l1 = a === 0n ? { weight: 0, first: 0n } : leading(a);
  const l2 = b === 0n ? { weight: 0, first: 0n } : leading(b);
  let qweight = l1.weight - l2.weight;
  // Postgres assumes var1 < var2 when the leading digits do not show otherwise.
  if (l1.first <= l2.first) qweight--;
  const rscale = NUMERIC_MIN_SIG_DIGITS - qweight * DEC_DIGITS;
  return Math.min(Math.max(rscale, 0), NUMERIC_MAX_DISPLAY_SCALE);
}

/** `a::numeric / b` exactly as Postgres returns it (non-negative integers, b > 0). */
export function pgDivide(a: number | bigint, b: number | bigint): Decimal {
  const x = BigInt(a);
  const y = BigInt(b);
  if (y <= 0n || x < 0n) throw new RangeError("pgDivide expects a >= 0 and b > 0");
  const scale = pgDivScale(x, y);
  const scaled = x * 10n ** BigInt(scale);
  // Round half away from zero (both operands are non-negative).
  const units = (scaled * 2n + y) / (2n * y);
  return { units, scale };
}

/** Parse a finite non-negative JS number the way jsonb stores its JSON text. */
export function decimalOf(value: number): Decimal {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`not a non-negative finite number: ${value}`);
  // JSON.stringify and String() agree for finite numbers: the shortest round-trip form.
  const text = String(value);
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new RangeError(`cannot parse number text: ${text}`);
  const intPart = match[1] ?? "0";
  const frac = match[2] ?? "";
  const exp = Number(match[3] ?? "0");
  let units = BigInt(intPart + frac);
  let scale = frac.length - exp;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units, scale };
}

/** -1, 0 or 1 as `a` is less than, equal to or greater than `b`. */
export function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1 {
  const scale = Math.max(a.scale, b.scale);
  const x = a.units * 10n ** BigInt(scale - a.scale);
  const y = b.units * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The Postgres result of `(num::numeric / den) < threshold`. */
export function ratioBelow(num: number, den: number, threshold: number): boolean {
  // A non-negative ratio is never below a negative threshold.
  if (threshold < 0) return false;
  return compareDecimal(pgDivide(num, den), decimalOf(threshold)) < 0;
}

/** The Postgres result of `(num::numeric / den) <= threshold`. */
export function ratioAtMost(num: number, den: number, threshold: number): boolean {
  if (threshold < 0) return false;
  return compareDecimal(pgDivide(num, den), decimalOf(threshold)) <= 0;
}

/** Display form of a decimal, e.g. for tally check details. */
export function formatDecimal(d: Decimal, digits = 4): string {
  const n = Number(d.units) / 10 ** d.scale;
  return n.toFixed(digits);
}
