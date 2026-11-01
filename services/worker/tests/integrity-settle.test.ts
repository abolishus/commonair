// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** ADR 0014 decision 3: the rollup and attestations wait until verdicts can no longer move. */
import { AUDIENCE_SETTLE_SECONDS, DEFAULT_FINALIZE_SECONDS } from "@commonair/integrity";
import { describe, expect, test } from "vite-plus/test";
import { INTEGRITY_SCHEDULES } from "../src/integrity/jobs.ts";

describe("AUDIENCE_SETTLE_SECONDS", () => {
  test("is at least the finalize window plus the slowest integrity job's interval and run limit", () => {
    const slowest = Math.max(...Object.values(INTEGRITY_SCHEDULES).map((s) => s.everyMs + s.maxRunMs));
    expect(slowest).toBe(5 * 60_000 + 20 * 60_000);
    expect(AUDIENCE_SETTLE_SECONDS * 1000).toBeGreaterThanOrEqual(DEFAULT_FINALIZE_SECONDS * 1000 + slowest);
  });
});
