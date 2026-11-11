// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The nightly `growth_daily` pass (overhaul wave 2, D2.8). A run lock keeps replicas apart. */
import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";
import { runGrowthDaily } from "./daily.ts";

export const GROWTH_DAILY_JOB = "growth-daily";
export const GROWTH_DAILY_LOCK_KEY = "worker:lock:analytics:growth-daily";

export const job = defineJob({
  queue: QUEUES.analytics,
  name: GROWTH_DAILY_JOB,
  description: "Daily: count yesterday's growth funnel steps (and fill missing days) into growth_daily",
  data: z.object({}),
  // Shortly after midnight UTC, so yesterday is complete.
  schedule: { pattern: "35 0 * * *", tz: "UTC" },
  attempts: 3,
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      GROWTH_DAILY_LOCK_KEY,
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: GROWTH_DAILY_JOB, logger: ctx.logger },
      () => runGrowthDaily(ctx.sql, ctx.now()),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
