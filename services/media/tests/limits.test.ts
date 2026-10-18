// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { DEFAULT_DISK_BUDGET, directorySize, DiskBudget, evaluateBudget } from "../src/disk.ts";
import { defaultTranscodeSlots, SlotLimiter } from "../src/transcode/slots.ts";

const logger = createLogger({ service: "test", level: "fatal" });
const cfg = { maxBytes: 1000, minFreeBytes: 100 };

describe("evaluateBudget", () => {
  test("within budget", () => {
    expect(evaluateBudget({ usedBytes: 0, freeBytes: 10_000 }, cfg)).toEqual({ ok: true });
    expect(evaluateBudget({ usedBytes: 1000, freeBytes: 100 }, cfg)).toEqual({ ok: true });
  });

  test("boundaries: exactly at the limits is allowed, one byte over is not", () => {
    expect(evaluateBudget({ usedBytes: 1001, freeBytes: 10_000 }, cfg)).toMatchObject({
      ok: false,
      reason: "work_dir_full",
    });
    expect(evaluateBudget({ usedBytes: 0, freeBytes: 99 }, cfg)).toMatchObject({ ok: false, reason: "filesystem_low" });
  });

  test("the requested size counts against both limits", () => {
    expect(evaluateBudget({ usedBytes: 900, freeBytes: 10_000 }, cfg, 100).ok).toBe(true);
    expect(evaluateBudget({ usedBytes: 900, freeBytes: 10_000 }, cfg, 101).ok).toBe(false);
    expect(evaluateBudget({ usedBytes: 0, freeBytes: 300 }, cfg, 201)).toMatchObject({ reason: "filesystem_low" });
  });

  test("unknown free space only applies the work-dir limit; the work-dir limit wins when both fail", () => {
    expect(evaluateBudget({ usedBytes: 10, freeBytes: null }, cfg).ok).toBe(true);
    expect(evaluateBudget({ usedBytes: 5000, freeBytes: 0 }, cfg)).toMatchObject({ reason: "work_dir_full" });
  });

  test("sane defaults", () => {
    expect(DEFAULT_DISK_BUDGET.maxBytes).toBeGreaterThan(DEFAULT_DISK_BUDGET.minFreeBytes);
  });
});

describe("DiskBudget", () => {
  const dir = mkdtempSync(join(tmpdir(), "media-disk-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("directorySize sums nested files and tolerates a missing dir", async () => {
    mkdirSync(join(dir, "a/b"), { recursive: true });
    writeFileSync(join(dir, "x.bin"), Buffer.alloc(100));
    writeFileSync(join(dir, "a/b/y.bin"), Buffer.alloc(250));
    expect(await directorySize(dir)).toBe(350);
    expect(await directorySize(join(dir, "missing"))).toBe(0);
  });

  test("measures the real directory and refuses over budget", async () => {
    const budget = new DiskBudget({ dir, logger, config: { maxBytes: 300, minFreeBytes: 0 }, cacheMs: 0 });
    expect(await budget.check("test")).toMatchObject({ ok: false, reason: "work_dir_full", usedBytes: 350 });
    const roomy = new DiskBudget({ dir, logger, config: { maxBytes: 10_000, minFreeBytes: 0 }, cacheMs: 0 });
    expect((await roomy.check("test")).ok).toBe(true);
  });

  test("caches measurements until invalidated", async () => {
    let calls = 0;
    const budget = new DiskBudget({
      dir,
      logger,
      config: cfg,
      cacheMs: 60_000,
      measure: async () => ({ usedBytes: ++calls * 600, freeBytes: null }),
    });
    expect((await budget.check("a")).ok).toBe(true);
    expect((await budget.check("b")).ok).toBe(true);
    expect(calls).toBe(1);
    budget.invalidate();
    expect((await budget.check("c")).ok).toBe(false);
    expect(calls).toBe(2);
  });

  test("a failing measurement allows the work instead of throwing", async () => {
    const budget = new DiskBudget({
      dir,
      logger,
      measure: async () => {
        throw new Error("EIO");
      },
    });
    await expect(budget.check("x")).resolves.toEqual({ ok: true });
  });
});

describe("SlotLimiter", () => {
  test("caps holders and is idempotent per owner", () => {
    const s = new SlotLimiter(2);
    expect(s.tryAcquire("a")).toBe(true);
    expect(s.tryAcquire("a")).toBe(true);
    expect(s.tryAcquire("b")).toBe(true);
    expect(s.inUse).toBe(2);
    expect(s.tryAcquire("c")).toBe(false);
    expect(s.queuePosition("c")).toBe(0);
    s.release("a");
    expect(s.tryAcquire("c")).toBe(true);
    expect(s.queuePosition("c")).toBeNull();
    expect(s.holds("c")).toBe(true);
  });

  test("a freed slot goes to the longest waiter, not to whoever asks first", () => {
    const s = new SlotLimiter(1);
    s.tryAcquire("a");
    expect(s.tryAcquire("b")).toBe(false);
    expect(s.tryAcquire("c")).toBe(false);
    expect(s.queuePosition("c")).toBe(1);
    s.release("a");
    expect(s.tryAcquire("c")).toBe(false);
    expect(s.tryAcquire("b")).toBe(true);
    s.release("b");
    expect(s.tryAcquire("c")).toBe(true);
  });

  test("leaving the queue, releasing twice and capacity 0", () => {
    const s = new SlotLimiter(1);
    s.tryAcquire("a");
    s.tryAcquire("b");
    s.release("b");
    expect(s.queuePosition("b")).toBeNull();
    s.release("a");
    s.release("a");
    expect(s.inUse).toBe(0);
    const none = new SlotLimiter(0);
    expect(none.tryAcquire("x")).toBe(false);
    expect(() => new SlotLimiter(-1)).toThrow("non-negative integer");
    expect(() => new SlotLimiter(1.5)).toThrow("non-negative integer");
  });

  test("default capacity follows the encoder and CPU count", () => {
    expect(defaultTranscodeSlots("h264_nvenc", 64)).toBe(2);
    expect(defaultTranscodeSlots("libx264", 16)).toBe(4);
    expect(defaultTranscodeSlots("libx264", 2)).toBe(1);
    expect(defaultTranscodeSlots("libx264", 1)).toBe(1);
  });
});
