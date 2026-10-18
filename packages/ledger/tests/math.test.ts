// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { floorShare, largestRemainder, mulDivFloor, toMicros } from "../src/math.ts";

describe("fractions", () => {
  test("toMicros is exact for typical settings and rejects out-of-range values", () => {
    expect(toMicros(0.9)).toBe(900_000n);
    expect(toMicros(0.1)).toBe(100_000n);
    expect(toMicros(0)).toBe(0n);
    expect(toMicros(1)).toBe(1_000_000n);
    expect(() => toMicros(1.01)).toThrow(RangeError);
    expect(() => toMicros(-0.1)).toThrow(RangeError);
    expect(() => toMicros(Number.NaN)).toThrow(RangeError);
  });

  test("floorShare avoids floating-point drift", () => {
    // 1000 × 0.9 is 900 exactly; 0.29 × 100 = 28.999999999999996 in floats.
    expect(floorShare(1000, 0.9)).toBe(900);
    expect(floorShare(100, 0.29)).toBe(29);
    expect(floorShare(999, 0.9)).toBe(899);
    expect(floorShare(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("mulDivFloor floors and rejects a zero denominator", () => {
    expect(mulDivFloor(10, 1n, 3n)).toBe(3);
    expect(() => mulDivFloor(10, 1n, 0n)).toThrow(RangeError);
  });
});

describe("largestRemainder", () => {
  test("parts always sum to the total", () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let i = 0; i < 500; i++) {
      const total = Math.floor(rand() * 1_000_000);
      const items = Array.from({ length: 1 + Math.floor(rand() * 12) }, (_, k) => ({
        key: k,
        weight: BigInt(Math.floor(rand() * 10_000)),
      }));
      if (items.every((x) => x.weight === 0n)) items[0]!.weight = 1n;
      const parts = largestRemainder(total, items);
      expect(parts.reduce((s, p) => s + p.cents, 0)).toBe(total);
      for (const [k, p] of parts.entries()) {
        const exact = (total * Number(items[k]!.weight)) / items.reduce((s, x) => s + Number(x.weight), 0);
        expect(Math.abs(p.cents - exact)).toBeLessThan(1);
      }
    }
  });

  test("ties go to the earlier item; zero weights get nothing", () => {
    const parts = largestRemainder(10, [
      { key: "a", weight: 1n },
      { key: "b", weight: 1n },
      { key: "c", weight: 1n },
      { key: "z", weight: 0n },
    ]);
    expect(parts).toEqual([
      { key: "a", cents: 4 },
      { key: "b", cents: 3 },
      { key: "c", cents: 3 },
      { key: "z", cents: 0 },
    ]);
  });

  test("zero weight overall is only valid for a zero total", () => {
    expect(largestRemainder(0, [{ key: "a", weight: 0n }])).toEqual([{ key: "a", cents: 0 }]);
    expect(() => largestRemainder(5, [{ key: "a", weight: 0n }])).toThrow(RangeError);
    expect(() => largestRemainder(-1, [{ key: "a", weight: 1n }])).toThrow(RangeError);
  });
});
