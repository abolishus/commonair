// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E8 scaffolding: the interactivity jobs are registered on their queue, and the hook flag warns. */
import { describe, expect, test, vi } from "vite-plus/test";
import { INTERACT_JOBS, INTERACT_JOB_NAMES, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { interactTestHooks } from "../src/interact/startup.ts";
import { JOBS } from "../src/jobs/index.ts";
import { buildRegistry } from "../src/runtime/registry.ts";

describe("interactivity jobs", () => {
  test("all three on QUEUES.interact with their schedules, one attempt each", () => {
    const reg = buildRegistry(JOBS);
    expect([...(reg.get(QUEUES.interact)?.keys() ?? [])].sort()).toEqual([...INTERACT_JOB_NAMES].sort());
    const every = (name: string) => {
      const s = reg.get(QUEUES.interact)?.get(name)?.schedule;
      return s && "every" in s ? s.every : undefined;
    };
    expect(every(INTERACT_JOBS.tick)).toBe(2_000);
    expect(every(INTERACT_JOBS.raidsExecute)).toBe(2_000);
    expect(every(INTERACT_JOBS.pointsAccrue)).toBe(60_000);
    for (const name of INTERACT_JOB_NAMES) {
      const def = reg.get(QUEUES.interact)?.get(name);
      expect(def?.data).toBe(InteractJob);
      expect(def?.attempts).toBe(1);
    }
  });
});

describe("interact test hooks flag", () => {
  test("warns at start and reports true when enabled", () => {
    const logger = { warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(interactTestHooks({ INTERACT_TEST_HOOKS: true }, logger)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatch(/test hooks are enabled/);
  });

  test("is silent and false when disabled", () => {
    const logger = { warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(interactTestHooks({ INTERACT_TEST_HOOKS: false }, logger)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
