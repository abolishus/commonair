// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { createRng } from "../../src/seed/prng.ts";

const num = (a: number, b: number) => a - b;

const draw = (seed: number, n = 20) => {
  const r = createRng(seed);
  return Array.from({ length: n }, () => r.next());
};

describe("createRng", () => {
  test("the same seed gives the same stream; another seed a different one", () => {
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
  });

  test("next stays in [0, 1)", () => {
    for (const x of draw(1, 10_000)) expect(x >= 0 && x < 1).toBe(true);
  });

  test("int covers both bounds and nothing outside them", () => {
    const r = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) seen.add(r.int(-2, 2));
    expect([...seen].sort(num)).toEqual([-2, -1, 0, 1, 2]);
    expect(r.int(5, 5)).toBe(5);
  });

  test("int rejects bad ranges", () => {
    const r = createRng(1);
    expect(() => r.int(3, 2)).toThrow(RangeError);
    expect(() => r.int(0.5, 2)).toThrow(RangeError);
  });

  test("pick throws on an empty list; sample and shuffle keep the elements", () => {
    const r = createRng(9);
    expect(() => r.pick([])).toThrow(RangeError);
    const items = [1, 2, 3, 4, 5];
    expect(r.shuffle(items).sort(num)).toEqual(items);
    const s = r.sample(items, 3);
    expect(new Set(s).size).toBe(3);
    expect(r.sample(items, 99).sort(num)).toEqual(items);
    expect(r.sample(items, -1)).toEqual([]);
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  test("chance(0) never, chance(1) always", () => {
    const r = createRng(4);
    for (let i = 0; i < 100; i++) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(1)).toBe(true);
    }
  });

  test("forks are stable per label and independent of how much the parent drew", () => {
    const a = createRng(5);
    const b = createRng(5);
    b.next();
    b.next();
    expect(a.fork("money").next()).toBe(b.fork("money").next());
    expect(a.fork("money").next()).not.toBe(a.fork("coop").next());
  });
});
