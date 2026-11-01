// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The unbiased index sampler behind `draw`, separated from the HMAC so tests can drive it with
 * crafted blocks and reach the rejection branch, which a real HMAC almost never takes.
 */

/** Bits read from each PRF block: the first 6 bytes, big-endian. 2^48 stays a safe integer. */
export const SAMPLE_BITS = 48;
export const SAMPLE_SPACE = 2 ** SAMPLE_BITS;
/** The largest entry list a draw accepts; far above any giveaway or jury pool. */
export const MAX_ENTRIES = 2 ** 24;

/** One PRF block per counter value, at least 6 bytes. */
export type Prf = (counter: number) => Promise<Uint8Array>;

/**
 * Samples at or above this are rejected for `range`: below it, every residue mod `range` occurs
 * equally often, so `sample % range` is uniform (no modulo bias).
 */
export function acceptLimit(range: number): number {
  if (!Number.isSafeInteger(range) || range < 1 || range > MAX_ENTRIES) throw new RangeError("range out of bounds");
  return SAMPLE_SPACE - (SAMPLE_SPACE % range);
}

export function sampleWord(block: Uint8Array): number {
  if (block.length < SAMPLE_BITS / 8) throw new Error("PRF block shorter than 6 bytes");
  let x = 0;
  for (let i = 0; i < SAMPLE_BITS / 8; i++) x = x * 256 + (block[i] ?? 0);
  return x;
}

/**
 * A partial Fisher-Yates shuffle of `0..n-1`, returning the first `k` positions in drawn order.
 * Each step takes PRF blocks at increasing counters (one counter per block, shared across steps)
 * until one falls under the acceptance limit. Drawing `k` is a prefix of drawing `n`, so a
 * re-draw after an ineligible winner just takes the next index.
 */
export async function shuffleIndices(prf: Prf, n: number, k: number): Promise<number[]> {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_ENTRIES) throw new RangeError("entry count out of bounds");
  if (!Number.isSafeInteger(k) || k < 0) throw new RangeError("count must be a non-negative integer");
  const take = Math.min(n, k);
  const pool = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  let counter = 0;
  for (let i = 0; i < take; i++) {
    const range = n - i;
    const limit = acceptLimit(range);
    let x: number;
    do {
      if (counter > Number.MAX_SAFE_INTEGER - 1) throw new Error("PRF counter exhausted");
      x = sampleWord(await prf(counter++));
    } while (x >= limit);
    const j = i + (x % range);
    // Invariant: i and j are within 0..n-1, so both reads are defined.
    const picked = pool[j] as number;
    pool[j] = pool[i] as number;
    pool[i] = picked;
    out.push(picked);
  }
  return out;
}
