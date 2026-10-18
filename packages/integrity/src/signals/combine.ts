// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Noisy-OR: independent pieces of evidence combine as 1 − Π(1 − sᵢ). Two weak signals
 * add up to more than either, but no number of zero-strength checks moves the score,
 * and the result stays in [0, 1].
 */
export function noisyOr(scores: readonly number[]): number {
  let keep = 1;
  for (const s of scores) keep *= 1 - clamp01(s);
  return round(1 - keep);
}

export const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Scores are stored and compared at 1e-6 so floating noise never flips a verdict. */
export const round = (x: number) => Math.round(x * 1e6) / 1e6;

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
