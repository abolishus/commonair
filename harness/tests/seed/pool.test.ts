// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-media's recording pool: slots refill as soon as one frees, and a failure drains, never abandons. */
import { describe, expect, test } from "vite-plus/test";
import { RECORDING_CONCURRENCY } from "../../src/seed/media/plan.ts";
import { poolSeconds, settledPool } from "../../src/seed/pool.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("settledPool", () => {
  test("results keep the input order, whatever order the calls end in", async () => {
    const delays = [30, 5, 20, 1, 10];
    const out = await settledPool(delays, 2, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
  });

  test("at most `limit` in flight, and the next starts as soon as one ends (no batch barrier)", async () => {
    const gates = [0, 1, 2, 3].map(() => deferred<number>());
    const started: number[] = [];
    const run = settledPool([0, 1, 2, 3], 2, (i) => {
      started.push(i);
      return (gates[i] as ReturnType<typeof deferred<number>>).promise;
    });
    await tick();
    expect(started).toEqual([0, 1]);
    // 1 ends while 0 is still running: 2 starts at once.
    gates[1]?.resolve(1);
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates[2]?.resolve(2);
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[0]?.resolve(0);
    gates[3]?.resolve(3);
    expect(await run).toEqual([0, 1, 2, 3]);
  });

  test("after a failure nothing new starts; calls in flight finish; the first error is thrown", async () => {
    const gates = [0, 1, 2].map(() => deferred<number>());
    const started: number[] = [];
    const finished: number[] = [];
    const run = settledPool([0, 1, 2], 2, async (i) => {
      started.push(i);
      const v = await (gates[i] as ReturnType<typeof deferred<number>>).promise;
      finished.push(i);
      return v;
    });
    let settled = false;
    void run.catch(() => undefined).finally(() => (settled = true));
    await tick();
    gates[0]?.reject(new Error("first"));
    await tick();
    // 1 is still publishing: the pool waits for it before throwing.
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    gates[1]?.reject(new Error("second"));
    await expect(run).rejects.toThrow("first");
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([]);
  });

  test("an aborted signal starts nothing more and throws its reason", async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const run = settledPool(
      [0, 1, 2],
      1,
      async (i) => {
        started.push(i);
        if (i === 0) ac.abort(new Error("aborted"));
        return i;
      },
      ac.signal,
    );
    await expect(run).rejects.toThrow("aborted");
    expect(started).toEqual([0]);
  });

  test("no items: nothing runs; a limit above the items runs them all at once", async () => {
    expect(await settledPool([], 4, async () => 1)).toEqual([]);
    let inFlight = 0;
    let peak = 0;
    await settledPool([1, 2, 3], 10, async () => {
      peak = Math.max(peak, ++inFlight);
      await tick();
      inFlight--;
    });
    expect(peak).toBe(3);
  });

  test("refuses a limit that is not a positive integer", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      await expect(settledPool([1], bad, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe("poolSeconds", () => {
  test("one slot sums; as many slots as items take the longest; empty is 0", () => {
    expect(poolSeconds([10, 20, 30], 1)).toBe(60);
    expect(poolSeconds([10, 20, 30], 3)).toBe(30);
    expect(poolSeconds([10, 20, 30], 8)).toBe(30);
    expect(poolSeconds([], 4)).toBe(0);
  });

  test("each next item takes the slot that frees first", () => {
    // Slots 0/1 end at 50/10; 30 goes to slot 1 (ends 40), 5 to slot 1 again (45): 50 overall.
    expect(poolSeconds([50, 10, 30, 5], 2)).toBe(50);
    expect(() => poolSeconds([1], 0)).toThrow(RangeError);
  });

  test("CI's recordings: four batches of three took 199 s; the pool of five under 120", () => {
    // Batch times on run 42215129857 were 69, 43, 50 and 37 s; each recording at most its batch's
    // (these are pessimistic: only each batch's longest is measured).
    const batches = [
      [69, 60, 45],
      [43, 40, 38],
      [50, 45, 42],
      [37, 35],
    ];
    const batched = batches.reduce((s, b) => s + Math.max(...b), 0);
    expect(batched).toBe(199);
    const pooled = poolSeconds(batches.flat(), RECORDING_CONCURRENCY);
    expect(pooled).toBeLessThanOrEqual(120);
    expect(poolSeconds(batches.flat(), 3)).toBeLessThan(batched);
    expect(pooled).toBeGreaterThanOrEqual(69);
  });
});
