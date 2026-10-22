// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXPORT_JOBS, ExportBuildJob, OPS_TICK_JOBS, QUEUES } from "@commonair/contracts/internal";
import { describe, expect, test, vi } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { opsTestHooks } from "../src/ops/startup.ts";
import { buildRegistry } from "../src/runtime/registry.ts";

describe("operations jobs (E6)", () => {
  const reg = buildRegistry(JOBS);

  test("every ops tick job is registered on the queue the API enqueues it on, with empty data", () => {
    const queueOf = {
      "account-deletion": QUEUES.deletions,
      "export-cleanup": QUEUES.exports,
      "vod-retention": QUEUES.retention,
    };
    for (const name of OPS_TICK_JOBS) {
      const def = reg.get(queueOf[name])?.get(name);
      expect(def, name).toBeDefined();
      expect(def?.data.safeParse({}).success).toBe(true);
      expect(def?.schedule, name).toBeDefined();
    }
  });

  test("the export build job takes the contract payload and retries three times", () => {
    const def = reg.get(QUEUES.exports)?.get(EXPORT_JOBS.build);
    expect(def?.data).toBe(ExportBuildJob);
    expect(def?.attempts).toBe(3);
    expect(def?.schedule).toBeUndefined();
    expect([...(reg.get(QUEUES.exports)?.keys() ?? [])].sort()).toEqual(
      [EXPORT_JOBS.build, EXPORT_JOBS.cleanup].sort(),
    );
  });
});

describe("ops test hooks flag", () => {
  test("warns at start and reports true when enabled", () => {
    const logger = { warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(opsTestHooks({ OPS_TEST_HOOKS: true }, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatch(/test hooks are enabled/);
  });

  test("is silent and false when disabled", () => {
    const logger = { warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(opsTestHooks({ OPS_TEST_HOOKS: false }, logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
