// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Co-op jobs: registration, schedules, result shape and the test-hook startup warning. */
import { COOP_JOB_NAMES, COOP_JOBS, CoopJobResult, QUEUES } from "@commonair/contracts/internal";
import { describe, expect, test, vi } from "vite-plus/test";
import { coopLockKey, counts } from "../src/coop/job.ts";
import { coopTestHooks } from "../src/coop/startup.ts";
import { JOBS } from "../src/jobs/index.ts";
import { buildRegistry, scheduledJobs } from "../src/runtime/registry.ts";

describe("co-op job registration", () => {
  const reg = buildRegistry(JOBS);
  const coop = reg.get(QUEUES.coop);

  test("every COOP_JOBS job is registered on QUEUES.coop, and nothing else is", () => {
    expect([...(coop?.keys() ?? [])].sort()).toEqual([...COOP_JOB_NAMES].sort());
  });

  test("schedules follow the spec", () => {
    expect(coop?.get(COOP_JOBS.proposalsAdvance)?.schedule).toEqual({ every: 15_000 });
    expect(coop?.get(COOP_JOBS.electionsAdvance)?.schedule).toEqual({ every: 60_000 });
    // Hourly.
    expect(coop?.get(COOP_JOBS.membershipSync)?.schedule).toEqual({ pattern: "5 * * * *", tz: "UTC" });
    // Daily at 03:10 UTC.
    expect(coop?.get(COOP_JOBS.councilRecompute)?.schedule).toEqual({ pattern: "10 3 * * *", tz: "UTC" });
    const scheduled = scheduledJobs(reg).map((j) => j.name);
    for (const name of COOP_JOB_NAMES) expect(scheduled).toContain(name);
  });

  test("jobs take the empty CoopJob payload and retry infrastructure errors", () => {
    for (const name of COOP_JOB_NAMES) {
      const def = coop!.get(name)!;
      expect(def.data.safeParse({}).success).toBe(true);
      expect(def.attempts).toBeGreaterThan(1);
    }
  });

  test("each job has its own run-lock key", () => {
    const keys = COOP_JOB_NAMES.map(coopLockKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(coopLockKey("proposals-advance")).toBe("worker:lock:coop:proposals-advance");
  });
});

describe("counts", () => {
  test("keeps integer counts and booleans as 0/1, drops everything else", () => {
    const r = counts({ a: 2, b: true, c: false, d: 1.5, e: null, f: undefined });
    expect(r).toEqual({ a: 2, b: 1, c: 0 });
    expect(CoopJobResult.safeParse(r).success).toBe(true);
  });
});

describe("COOP_TEST_HOOKS", () => {
  test("warns at start and reports true when enabled", () => {
    const logger = { warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(coopTestHooks({ COOP_TEST_HOOKS: true }, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/test hooks are enabled/);
  });

  test("is silent and false when disabled", () => {
    const logger = { warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(coopTestHooks({ COOP_TEST_HOOKS: false }, logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
