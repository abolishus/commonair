// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { ByteLru, Coalescer, Semaphore, TtlCache } from "../src/cache.ts";

const v = (size: number) => ({ size });

describe("ByteLru", () => {
  test("evicts least recently used entries to stay within the byte budget", () => {
    const lru = new ByteLru<{ size: number }>(100, 100);
    lru.set("a", v(40), 1000);
    lru.set("b", v(40), 1000);
    expect(lru.get("a")).toBeDefined(); // a is now most recent
    lru.set("c", v(40), 1000);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBeDefined();
    expect(lru.get("c")).toBeDefined();
    expect(lru.bytes).toBe(80);
  });

  test("replacing a key frees its old size", () => {
    const lru = new ByteLru<{ size: number }>(100, 100);
    lru.set("a", v(60), 1000);
    lru.set("a", v(10), 1000);
    expect(lru.bytes).toBe(10);
    expect(lru.size).toBe(1);
  });

  test("never caches entries above the per-entry cap or with a non-positive TTL", () => {
    const lru = new ByteLru<{ size: number }>(800);
    expect(lru.set("big", v(101), 1000)).toBe(false);
    expect(lru.set("zero", v(1), 0)).toBe(false);
    expect(lru.size).toBe(0);
  });

  test("entries expire", () => {
    let now = 0;
    const lru = new ByteLru<{ size: number }>(100, 100, () => now);
    lru.set("a", v(10), 50);
    now = 49;
    expect(lru.get("a")).toBeDefined();
    now = 50;
    expect(lru.get("a")).toBeUndefined();
    expect(lru.bytes).toBe(0);
  });
});

describe("Coalescer", () => {
  test("concurrent callers for a key share one execution; later callers start fresh", async () => {
    const c = new Coalescer<number>();
    let calls = 0;
    let release: (n: number) => void = () => {};
    const fn = () => {
      calls++;
      return new Promise<number>((r) => (release = r));
    };
    const runs = Array.from({ length: 100 }, () => c.run("k", fn));
    expect(calls).toBe(1);
    expect(runs.filter((r) => r.joined)).toHaveLength(99);
    release(7);
    expect(await Promise.all(runs.map((r) => r.promise))).toEqual(Array(100).fill(7));
    expect(c.pending).toBe(0);
    void c.run("k", async () => (calls++, 1)).promise;
    expect(calls).toBe(2);
  });

  test("a rejection reaches every joined caller and clears the key", async () => {
    const c = new Coalescer<number>();
    const a = c.run("k", () => Promise.reject(new Error("boom")));
    const b = c.run("k", () => Promise.resolve(1));
    await expect(a.promise).rejects.toThrow("boom");
    await expect(b.promise).rejects.toThrow("boom");
    expect(c.pending).toBe(0);
  });

  test("different keys run independently", () => {
    const c = new Coalescer<number>();
    expect(c.run("a", () => Promise.resolve(1)).joined).toBe(false);
    expect(c.run("b", () => Promise.resolve(2)).joined).toBe(false);
  });
});

describe("TtlCache", () => {
  test("expires and bounds entry count", () => {
    let now = 0;
    const t = new TtlCache<string>(2, () => now);
    t.set("a", "1", 10);
    t.set("b", "2", 10);
    t.set("c", "3", 10);
    expect(t.get("a")).toBeUndefined();
    expect(t.get("c")).toBe("3");
    now = 10;
    expect(t.get("c")).toBeUndefined();
  });

  test("caches null (negative) values distinctly from misses", () => {
    const t = new TtlCache<string | null>();
    t.set("x", null, 1000);
    expect(t.get("x")).toBeNull();
    expect(t.get("y")).toBeUndefined();
  });
});

describe("Semaphore", () => {
  test("never exceeds its limit and drains all waiters", async () => {
    const s = new Semaphore(3);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        s.use(async () => {
          active++;
          peak = Math.max(peak, active);
          await Bun.sleep(2);
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(s.inUse).toBe(0);
  });

  test("releases the slot when the task throws", async () => {
    const s = new Semaphore(1);
    await expect(s.use(() => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await s.use(() => Promise.resolve(5))).toBe(5);
  });
});
