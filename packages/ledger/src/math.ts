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

/** Total basis points (100%). */
export const BPS_TOTAL = 10_000;

/** Byte order of lowercased user ids: the one order shares, locks and payout batches use (decision (i)). */
export function compareUserIds(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface SplitShareOut {
  userId: string;
  role: "owner" | "crew";
  bps: number;
  creatorCents: number;
}

/**
 * Divide a payment's creator share between the owner and the crew of a split version (ADR 0013
 * decision 3): crew weighted by their basis points, the owner by the remaining ones, with
 * `largestRemainder` over items ordered by lowercased user id, so ties are deterministic and the
 * parts sum to `creatorCents` exactly. No crew: the owner alone at 10,000 bps.
 */
export function splitNetN(
  creatorCents: number,
  ownerUserId: string,
  crew: readonly { userId: string; bps: number }[] = [],
): SplitShareOut[] {
  assertCents("creator", creatorCents);
  const owner = ownerUserId.toLowerCase();
  const seen = new Set<string>([owner]);
  let crewBps = 0;
  for (const c of crew) {
    const id = c.userId.toLowerCase();
    if (seen.has(id))
      throw new RangeError(id === owner ? "the owner is never a crew recipient" : "each recipient once");
    seen.add(id);
    if (!Number.isSafeInteger(c.bps) || c.bps < 1 || c.bps >= BPS_TOTAL) {
      throw new RangeError(`crew basis points must be within [1, ${BPS_TOTAL - 1}], got ${c.bps}`);
    }
    crewBps += c.bps;
  }
  if (crewBps > BPS_TOTAL) throw new RangeError(`crew basis points total ${crewBps}, more than ${BPS_TOTAL}`);
  const items: Omit<SplitShareOut, "creatorCents">[] = [
    { userId: owner, role: "owner" as const, bps: BPS_TOTAL - crewBps },
    ...crew.map((c) => ({ userId: c.userId.toLowerCase(), role: "crew" as const, bps: c.bps })),
  ].sort((a, b) => compareUserIds(a.userId, b.userId));
  const parts = largestRemainder(
    creatorCents,
    items.map((i, key) => ({ key, weight: BigInt(i.bps) })),
  );
  return items.map((i, k) => ({ ...i, creatorCents: parts[k]?.cents ?? 0 }));
}

/**
 * The first `total` cents of a vector of integer weights, apportioned by the D'Hondt divisor
 * method (the `total` largest quotients weight/1, weight/2, …; ties to the earlier item).
 * Unlike `largestRemainder` it is monotone in `total` (no Alabama paradox: no part ever shrinks
 * when the total grows), and at `total = Σ weights` every part is exactly its weight. So the
 * difference of two cumulative apportionments is never negative, and any sequence of partial
 * reversals returns each recipient exactly their slice (ADR 0013 decision 3).
 */
export function apportionCumulative(total: number, weights: readonly number[]): number[] {
  assertCents("total", total);
  for (const w of weights) assertCents("weight", w);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (total > sum) throw new RangeError(`cannot apportion ${total} over weights summing to ${sum}`);
  if (total === 0) return weights.map(() => 0);
  const t = BigInt(total);
  const s = BigInt(sum);
  // Every quotient ≥ sum/total is among the `total` largest, and there are at most `total` of them.
  const parts = weights.map((w) => (BigInt(w) * t) / s);
  let left = t - parts.reduce((a, p) => a + p, 0n);
  // Fewer than `weights.length` remain: each goes to the largest next quotient w / (a + 1).
  while (left > 0n) {
    let best = -1;
    for (let i = 0; i < weights.length; i++) {
      const w = BigInt(weights[i] ?? 0);
      if (w === 0n) continue;
      if (best < 0) {
        best = i;
        continue;
      }
      const a = parts[i] ?? 0n;
      const bw = BigInt(weights[best] ?? 0);
      const ba = parts[best] ?? 0n;
      // w / (a + 1) > bw / (ba + 1), strictly: ties keep the earlier item.
      if (w * (ba + 1n) > bw * (a + 1n)) best = i;
    }
    if (best < 0) throw new RangeError("cannot apportion over zero weights");
    parts[best] = (parts[best] ?? 0n) + 1n;
    left -= 1n;
  }
  return parts.map((p) => Number(p));
}
