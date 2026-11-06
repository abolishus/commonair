// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `seed-coverage` without a database to read: every route is skipped, with the reason. */
import { createLogger } from "@commonair/observability";
import { describe, expect, test } from "vite-plus/test";
import seedCoverage from "../../scenarios/seed-coverage.ts";
import { loadHarnessEnv } from "../../src/env.ts";
import type { Platform } from "../../src/platform.ts";
import { runOne } from "../../src/runner.ts";
import { SEED_ROUTES } from "../../src/seed/routes.ts";

const log = createLogger({ service: "harness-test", level: "fatal", write: () => undefined });
const platform = { probe: async () => null } as unknown as Platform;

describe("seed-coverage", () => {
  test("no DATABASE_URL: every route skipped, nothing seeded, no failure", async () => {
    const env = loadHarnessEnv({});
    const r = await runOne(seedCoverage, platform, {
      command: "run",
      profile: "default",
      env,
      log,
      platform,
      runId: "r1",
    });
    expect(r.status).toBe("passed");
    expect(r.skippedSteps?.map((s) => s.name)).toEqual(Object.keys(SEED_ROUTES));
    expect(new Set(r.skippedSteps?.map((s) => s.reason))).toEqual(new Set(["DATABASE_URL is not set"]));
    expect(r.metrics).toEqual({});
  });
});
