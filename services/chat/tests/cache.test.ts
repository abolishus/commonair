// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { TtlCache } from "../src/cache.ts";
import { MemoryLimiter } from "../src/limiter.ts";
import { takeToken, type ConnData } from "../src/socket.ts";

describe("TtlCache", () => {
  test("shares concurrent loads and expires entries", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<string, number>(1000, 10, () => now);
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    now = 999;
    expect(await cache.get("k", load)).toBe(1);
    now = 1000;
    expect(await cache.get("k", load)).toBe(2);
  });

  test("failed loads are evicted", async () => {
    const cache = new TtlCache<string, number>(60_000);
    await expect(cache.get("k", () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    expect(await cache.get("k", async () => 7)).toBe(7);
  });

  test("evicts least recently used beyond capacity", async () => {
    const cache = new TtlCache<string, string>(60_000, 2);
    await cache.get("a", async () => "a");
    await cache.get("b", async () => "b");
    await cache.get("a", async () => "a2"); // touch a
    await cache.get("c", async () => "c");
    expect(await cache.get("a", async () => "reloaded")).toBe("a");
    expect(await cache.get("b", async () => "reloaded")).toBe("reloaded");
  });

  test("delete and deleteWhere", async () => {
    const cache = new TtlCache<string, number>(60_000);
    for (const k of ["c1:u1", "c1:u2", "c2:u1"]) await cache.get(k, async () => 1);
    cache.deleteWhere((k) => k.startsWith("c1:"));
    expect(cache.size).toBe(1);
    cache.delete("c2:u1");
    expect(cache.size).toBe(0);
  });
});

describe("MemoryLimiter", () => {
  test("slow mode is recorded only on commit", async () => {
    let now = 0;
    const l = new MemoryLimiter(() => now);
    expect(await l.slowRemainingMs("c", "u")).toBe(0);
    await l.commit("c", "u", "x", 10, 30_000);
    now = 4000;
    expect(await l.slowRemainingMs("c", "u")).toBe(6000);
    expect(await l.slowRemainingMs("c", "other")).toBe(0);
  });

  test("windows are per channel and per user", async () => {
    const l = new MemoryLimiter(() => 0);
    expect(await l.hit("c", "u", 1, 1000, 0)).toBe(true);
    expect(await l.hit("c", "u", 1, 1000, 0)).toBe(false);
    expect(await l.hit("c2", "u", 1, 1000, 0)).toBe(true);
    expect(await l.hit("c", "u2", 1, 1000, 0)).toBe(true);
  });
});

describe("control-frame token bucket", () => {
  test("allows a burst then refills over time", () => {
    const data = { bucket: { tokens: 3, updated: 0 } } as ConnData;
    expect([
      takeToken(data, 0, 3, 1),
      takeToken(data, 0, 3, 1),
      takeToken(data, 0, 3, 1),
      takeToken(data, 0, 3, 1),
    ]).toEqual([true, true, true, false]);
    expect(takeToken(data, 1000, 3, 1)).toBe(true);
    expect(takeToken(data, 1000, 3, 1)).toBe(false);
  });
});
