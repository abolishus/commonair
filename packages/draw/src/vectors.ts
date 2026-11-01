// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Regenerate vectors.json (`bun run vectors`). Every input is fixed and every function is
 * deterministic, so the output is stable; tests recompute each entry and compare.
 */
import { commit, draw, entriesHash, pseudonym } from "./index.ts";

const hexOf = (start: number, length: number) =>
  Array.from({ length }, (_, i) => ((start + i) & 0xff).toString(16).padStart(2, "0")).join("");

/** Fixed test seeds: 0x00..0x1f, 0x20..0x3f, and a 16-byte minimum-length seed. */
export const SEEDS = [hexOf(0, 32), hexOf(0x20, 32), hexOf(0xf0, 16)] as const;
export const SALT = hexOf(0x80, 32);

/** Edge sizes: 0, 1, and 2^k ± 1 around small powers of two, plus 2^k itself. */
export const SIZES = [0, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129] as const;

/** A sorted list of `n` UUID-shaped user ids. */
export function entryList(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `01890000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`);
}

/** Counts per size: none, one, all but one, all, and more than all. */
export function countsFor(n: number): number[] {
  return [...new Set([0, 1, Math.max(n - 1, 0), n, n + 3])].sort((a, b) => a - b);
}

export async function drawVectors() {
  const commitments = await Promise.all(SEEDS.map(async (seed) => ({ seed, commitment: await commit(seed) })));
  const draws = [];
  for (const seed of SEEDS.slice(0, 2)) {
    for (const size of SIZES) {
      const entries = entryList(size);
      for (const count of countsFor(size))
        draws.push({ seed, size, count, domain: "", indices: await draw(seed, entries, count) });
    }
  }
  // Domain separation: the jury's seats and cases from one seed differ.
  const domains = [];
  for (const domain of ["seats", "cases"]) {
    const entries = entryList(33);
    domains.push({ seed: SEEDS[0], size: 33, count: 7, domain, indices: await draw(SEEDS[0], entries, 7, domain) });
  }
  // The short seed is valid for draws too.
  const shortSeed = { seed: SEEDS[2], size: 9, count: 9, domain: "", indices: await draw(SEEDS[2], entryList(9), 9) };
  const userIds = entryList(3);
  const pseudonyms = await Promise.all(
    userIds.map(async (userId) => ({ salt: SALT, userId, pseudonym: await pseudonym(SALT, userId) })),
  );
  return {
    note: "Test vectors for packages/draw. entries for size n are entryList(n) in src/vectors.ts.",
    entriesHash: { size: 3, hash: await entriesHash(entryList(3)) },
    commitments,
    pseudonyms,
    draws: [...draws, ...domains, shortSeed],
  };
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await drawVectors(), null, 2)}\n`);
