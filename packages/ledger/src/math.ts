// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact integer money arithmetic. Fractions (cut shares, weights) are settings stored as
 * JSON numbers; they are converted to integer millionths once, and every product is computed
 * with BigInt so results never depend on floating-point rounding.
 */

/** Fractions are resolved to millionths (0.9 → 900000). */
export const FRACTION_SCALE = 1_000_000n;

export function assertCents(name: string, value: number, { allowZero = true } = {}): void {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer number of cents`);
  }
}

/** A fraction in [0, 1] as integer millionths. */
export function toMicros(fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`fraction must be within [0, 1], got ${fraction}`);
  }
  return BigInt(Math.round(fraction * Number(FRACTION_SCALE)));
}

/** floor(amount × numerator / denominator) for non-negative integers. */
export function mulDivFloor(amount: number, numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return Number((BigInt(amount) * numerator) / denominator);
}

/** floor(amount × fraction), exact. */
export function floorShare(amount: number, fraction: number): number {
  return mulDivFloor(amount, toMicros(fraction), FRACTION_SCALE);
}

/** −x without producing −0 (which breaks equality checks and reads oddly). */
export function negate(x: number): number {
  return x === 0 ? 0 : -x;
}

export interface Weighted<K> {
  key: K;
  weight: bigint;
}

/**
 * Split `total` cents in proportion to integer weights so the parts sum to `total` exactly
 * (largest-remainder / Hamilton method). Leftover cents go to the largest fractional
 * remainders; ties go to the earlier item, so callers fix the order (e.g. by user id) to make
 * the result deterministic. Zero-weight items always get zero.
 */
export function largestRemainder<K>(total: number, items: readonly Weighted<K>[]): { key: K; cents: number }[] {
  assertCents("total", total);
  const sum = items.reduce((s, i) => {
    if (i.weight < 0n) throw new RangeError("weights must be non-negative");
    return s + i.weight;
  }, 0n);
  if (sum === 0n) {
    if (total !== 0) throw new RangeError("cannot split a non-zero total over zero weight");
    return items.map((i) => ({ key: i.key, cents: 0 }));
  }
  const t = BigInt(total);
  const parts = items.map((i, index) => ({
    key: i.key,
    index,
    base: (t * i.weight) / sum,
    remainder: (t * i.weight) % sum,
  }));
  let leftover = t - parts.reduce((s, p) => s + p.base, 0n);
  const order = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const p of order) {
    if (leftover === 0n) break;
    if (p.remainder === 0n) continue;
    p.base += 1n;
    leftover -= 1n;
  }
  return parts.map((p) => ({ key: p.key, cents: Number(p.base) }));
}
