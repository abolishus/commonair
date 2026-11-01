// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, createHmac } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { acceptLimit, MAX_ENTRIES, SAMPLE_SPACE, sampleWord, shuffleIndices } from "../src/core.ts";
import {
  commit,
  DRAW_VERSION,
  draw,
  drawEntries,
  entriesHash,
  isSortedUnique,
  newSalt,
  newSeed,
  pseudonym,
  verifyReveal,
} from "../src/index.ts";
import { countsFor, drawVectors, entryList, SALT, SEEDS, SIZES } from "../src/vectors.ts";
import vectors from "../vectors.json" with { type: "json" };

describe("vectors", () => {
  test("the committed file is exactly what the generator produces", async () => {
    expect(await drawVectors()).toEqual(vectors);
  });

  test("cover every edge size and count", () => {
    for (const seed of SEEDS.slice(0, 2))
      for (const size of SIZES)
        for (const count of countsFor(size))
          expect(vectors.draws.some((d) => d.seed === seed && d.size === size && d.count === count)).toBe(true);
    expect(SIZES).toContain(0);
    expect(SIZES).toContain(1);
  });

  test.each(vectors.commitments)("commitment of $seed", async ({ seed, commitment }) => {
    expect(await commit(seed)).toBe(commitment);
    expect(commitment).toBe(createHash("sha256").update(Buffer.from(seed, "hex")).digest("hex"));
    expect(await verifyReveal(seed, commitment)).toBe(true);
  });

  test.each(vectors.pseudonyms)("pseudonym of $userId", async ({ salt, userId, pseudonym: p }) => {
    expect(await pseudonym(salt, userId)).toBe(p);
    expect(p).toBe(createHmac("sha256", Buffer.from(salt, "hex")).update(userId, "utf8").digest("hex"));
  });

  test("entriesHash is SHA-256 of the JSON list", async () => {
    expect(await entriesHash(entryList(vectors.entriesHash.size))).toBe(vectors.entriesHash.hash);
    expect(vectors.entriesHash.hash).toBe(
      createHash("sha256")
        .update(JSON.stringify(entryList(3)))
        .digest("hex"),
    );
  });

  test.each(vectors.draws.map((d) => [`${d.seed.slice(0, 8)} n=${d.size} k=${d.count} ${d.domain}`, d] as const))(
    "draw %s",
    async (_, { seed, size, count, domain, indices }) => {
      const entries = entryList(size);
      const got = await draw(seed, entries, count, domain);
      expect(got).toEqual(indices);
      expect(got).toHaveLength(Math.min(count, size));
      expect(new Set(got).size).toBe(got.length);
      for (const i of got) expect(i >= 0 && i < size).toBe(true);
      // Every index is drawn exactly when the count reaches the size.
      expect(new Set(got).size === size).toBe(count >= size);
    },
  );
});

describe("the documented algorithm", () => {
  /** An independent re-implementation from the format text in index.ts, on node:crypto. */
  function reference(seed: string, entries: string[], count: number, domain = ""): number[] {
    const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
    const pool = entries.map((_, i) => i);
    const out: number[] = [];
    let counter = 0;
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      const range = entries.length - i;
      const limit = 2 ** 48 - (2 ** 48 % range);
      let x: number;
      do {
        const block = createHmac("sha256", Buffer.from(seed, "hex"))
          .update(`${DRAW_VERSION}\n${domain}\n${hash}\n${counter++}`)
          .digest();
        x = block.readUIntBE(0, 6);
      } while (x >= limit);
      const j = i + (x % range);
      [pool[i], pool[j]] = [pool[j] as number, pool[i] as number];
      out.push(pool[i] as number);
    }
    return out;
  }

  test.each([0, 1, 2, 9, 33, 129])("matches the reference for n=%i", async (n) => {
    for (const domain of ["", "seats"])
      expect(await draw(SEEDS[1], entryList(n), n, domain)).toEqual(reference(SEEDS[1], entryList(n), n, domain));
  });
});

describe("draw properties", () => {
  test("a smaller count is a prefix of a larger one", async () => {
    const entries = entryList(65);
    const all = await draw(SEEDS[0], entries, 65);
    for (const k of [0, 1, 2, 10, 64]) expect(await draw(SEEDS[0], entries, k)).toEqual(all.slice(0, k));
  });

  test("the seed, the list and the domain each change the result", async () => {
    const entries = entryList(64);
    const base = await draw(SEEDS[0], entries, 64);
    expect(await draw(SEEDS[1], entries, 64)).not.toEqual(base);
    expect(await draw(SEEDS[0], entries, 64, "cases")).not.toEqual(base);
    const changed = [...entries.slice(0, 63), "01890000-0000-7000-8000-ffffffffffff"];
    expect(await draw(SEEDS[0], changed, 64)).not.toEqual(base);
  });

  test("drawEntries maps indices to entries", async () => {
    const entries = entryList(9);
    const idx = await draw(SEEDS[0], entries, 3);
    expect(await drawEntries(SEEDS[0], entries, 3)).toEqual(idx.map((i) => entries[i]));
  });

  test("first picks are roughly uniform over many seeds", async () => {
    const n = 5;
    const runs = 2_000;
    const counts = Array.from({ length: n }, () => 0);
    for (let r = 0; r < runs; r++) {
      const seed = createHash("sha256").update(`seed-${r}`).digest("hex");
      const [first] = await draw(seed, entryList(n), 1);
      counts[first as number]! += 1;
    }
    // Chi-square with 4 degrees of freedom; 18.47 is the 0.999 quantile.
    const expected = runs / n;
    const chi = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(18.47);
  });

  test("refuses unsorted, duplicate and malformed input", async () => {
    await expect(draw(SEEDS[0], ["b", "a"], 1)).rejects.toThrow(/sorted/);
    await expect(draw(SEEDS[0], ["a", "a"], 1)).rejects.toThrow(/sorted/);
    await expect(draw(SEEDS[0], ["a"], -1)).rejects.toThrow(RangeError);
    await expect(draw(SEEDS[0], ["a"], 1.5)).rejects.toThrow(RangeError);
    await expect(draw(SEEDS[0], ["a"], 1, "x\ny")).rejects.toThrow(/domain/);
    await expect(draw(SEEDS[0], ["a"], 1, "x".repeat(65))).rejects.toThrow(/domain/);
    await expect(draw("ABCD", ["a"], 1)).rejects.toThrow(/hex/);
    await expect(draw("00".repeat(15), ["a"], 1)).rejects.toThrow(/bytes/);
    await expect(draw("00".repeat(65), ["a"], 1)).rejects.toThrow(/bytes/);
    // A bad seed is refused even when there is nothing to draw.
    await expect(draw("zz", [], 0)).rejects.toThrow(/hex/);
  });

  test("isSortedUnique uses code-unit order", () => {
    expect(isSortedUnique([])).toBe(true);
    expect(isSortedUnique(["a"])).toBe(true);
    expect(isSortedUnique(["B", "a"])).toBe(true);
    expect(isSortedUnique(["a", "B"])).toBe(false);
    expect(isSortedUnique(["a", "b", "b"])).toBe(false);
  });
});

describe("commit and reveal", () => {
  test("fresh seeds and salts are 32 random bytes in hex", async () => {
    const a = newSeed();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newSeed()).not.toBe(a);
    expect(newSalt()).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyReveal(a, await commit(a))).toBe(true);
  });

  test("a wrong or malformed reveal is refused without throwing", async () => {
    const c = await commit(SEEDS[0]);
    expect(await verifyReveal(SEEDS[1], c)).toBe(false);
    expect(await verifyReveal(SEEDS[0], c.toUpperCase())).toBe(false);
    expect(await verifyReveal(SEEDS[0], c.slice(1))).toBe(false);
    expect(await verifyReveal("not hex", c)).toBe(false);
    expect(await verifyReveal(SEEDS[0].toUpperCase(), c)).toBe(false);
  });

  test("pseudonyms are stable per salt and differ across salts", async () => {
    const id = entryList(1)[0] as string;
    expect(await pseudonym(SALT, id)).toBe(await pseudonym(SALT, id));
    expect(await pseudonym(SEEDS[0], id)).not.toBe(await pseudonym(SALT, id));
    await expect(pseudonym(SALT, "")).rejects.toThrow(/userId/);
  });
});

describe("core sampler", () => {
  const block = (x: number) => {
    const b = new Uint8Array(32);
    let v = x;
    for (let i = 5; i >= 0; i--) {
      b[i] = v % 256;
      v = Math.floor(v / 256);
    }
    return b;
  };

  test("sampleWord reads 48 bits big-endian", () => {
    expect(sampleWord(block(0))).toBe(0);
    expect(sampleWord(block(SAMPLE_SPACE - 1))).toBe(SAMPLE_SPACE - 1);
    expect(sampleWord(block(0x0102030405))).toBe(0x0102030405);
    expect(() => sampleWord(new Uint8Array(5))).toThrow(/6 bytes/);
  });

  test("acceptLimit is the largest multiple of the range", () => {
    expect(acceptLimit(1)).toBe(SAMPLE_SPACE);
    expect(acceptLimit(2)).toBe(SAMPLE_SPACE);
    expect(acceptLimit(3)).toBe(SAMPLE_SPACE - 1);
    expect(acceptLimit(MAX_ENTRIES)).toBe(SAMPLE_SPACE);
    for (const r of [3, 5, 7, 1000, MAX_ENTRIES - 1]) expect(acceptLimit(r) % r).toBe(0);
    expect(() => acceptLimit(0)).toThrow(RangeError);
    expect(() => acceptLimit(MAX_ENTRIES + 1)).toThrow(RangeError);
  });

  test("rejected samples consume a counter and are retried", async () => {
    // Range 3: limit is 2^48 - 1, so the sample 2^48 - 1 is rejected.
    const seen: number[] = [];
    const words = [SAMPLE_SPACE - 1, SAMPLE_SPACE - 1, 4, 1];
    const prf = async (counter: number) => {
      seen.push(counter);
      return block(words[counter] as number);
    };
    // Step 0: two rejections, then 4 % 3 = 1 → index 1. Step 1: range 2, 1 % 2 = 1 → pool[2] = 2.
    expect(await shuffleIndices(prf, 3, 2)).toEqual([1, 2]);
    expect(seen).toEqual([0, 1, 2, 3]);
  });

  test("the last sample of the space is accepted when the range divides it", async () => {
    expect(await shuffleIndices(async () => block(SAMPLE_SPACE - 1), 2, 1)).toEqual([1]);
  });

  test("bounds", async () => {
    const prf = async () => block(0);
    expect(await shuffleIndices(prf, 0, 5)).toEqual([]);
    expect(await shuffleIndices(prf, 4, 10)).toEqual([0, 1, 2, 3]);
    await expect(shuffleIndices(prf, -1, 1)).rejects.toThrow(RangeError);
    await expect(shuffleIndices(prf, MAX_ENTRIES + 1, 1)).rejects.toThrow(RangeError);
    await expect(shuffleIndices(prf, 3, -1)).rejects.toThrow(RangeError);
  });
});
