// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Deterministic randomness for the full seed: the same `--seed` gives the same names, counts and
 * picks on every run, so screenshots and walkthroughs match. Never use it for secrets (passwords
 * and keys come from `node:crypto`). Each unit forks its own stream, so adding rows to one unit
 * does not shift another unit's data.
 */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** One element; throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** `n` distinct elements (all of them, shuffled, when `n` exceeds the length). */
  sample<T>(items: readonly T[], n: number): T[];
  /** A new list in random order. */
  shuffle<T>(items: readonly T[]): T[];
  /** An independent stream named `label`, stable for a given parent seed. */
  fork(label: string): Rng;
}

/** 32-bit FNV-1a, to turn labels into seeds. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  // mulberry32: small, fast and well distributed enough for fixture data.
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`bad range ${min}..${max}`);
    return min + Math.floor(next() * (max - min + 1));
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  };
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new RangeError("pick from an empty list");
      return items[int(0, items.length - 1)] as (typeof items)[number];
    },
    sample: (items, n) => shuffle(items).slice(0, Math.max(0, n)),
    shuffle,
    fork: (label) => createRng(fnv1a(`${seed}:${label}`)),
  };
}
