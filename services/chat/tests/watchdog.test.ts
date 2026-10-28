// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { DeadlineError, watchEventLoop, withDeadline } from "../src/watchdog.ts";

describe("withDeadline", () => {
  test("passes a value through when it settles in time", async () => {
    await expect(withDeadline(Promise.resolve(7), 100)).resolves.toBe(7);
  });

  test("passes a rejection through when it settles in time", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 100)).rejects.toThrow("boom");
  });

  test("rejects with DeadlineError when the promise never settles", async () => {
    const started = performance.now();
    const err = await withDeadline(new Promise(() => {}), 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as DeadlineError).timeoutMs).toBe(50);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a late rejection of the abandoned promise is not unhandled", async () => {
    let reject: (e: Error) => void = () => {};
    const p = new Promise<never>((_, r) => {
      reject = r;
    });
    await expect(withDeadline(p, 10)).rejects.toBeInstanceOf(DeadlineError);
    reject(new Error("late"));
    await Bun.sleep(10);
  });
});

describe("watchEventLoop", () => {
  test("reports a blocked event loop, and not an idle one", async () => {
    const stalls: number[] = [];
    const stop = watchEventLoop((lag) => stalls.push(lag), 20, 150);
    try {
      await Bun.sleep(100);
      expect(stalls).toEqual([]);
      Bun.sleepSync(300);
      await Bun.sleep(60);
      expect(stalls.length).toBe(1);
      expect(stalls[0]).toBeGreaterThanOrEqual(150);
    } finally {
      stop();
    }
  });
});
