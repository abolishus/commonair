// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { withRunLock } from "../integrity/lock.ts";
import { moderationMetrics } from "../moderation/metrics.ts";
import { buildStatements } from "../moderation/sor-build.ts";
import { sorCoverage } from "../moderation/sor-coverage.ts";
import { deliverStatements } from "../moderation/sor-deliver.ts";
import { defineJob, type JobDefinition, type Schedule } from "../runtime/registry.ts";
import { moderationLockKey } from "./moderation-schedules.ts";

/**
 * Statements of reasons (ADR 0019 decision 5). `sor-build` turns allowlisted `audit_log` rows
 * (`ENFORCEMENT_SOURCE_ACTIONS`) into `enforcement_statements` and delivers them; `sor-coverage`
 * counts allowlisted rows older than 5 minutes that have none and alerts. Each runs under a
 * Valkey run lock (the `moderation-schedules.ts` pattern), so replicas never build twice.
 */
function locked(
  name: string,
  description: string,
  schedule: Schedule,
  maxRunMs: number,
  run: (ctx: WorkerContext) => Promise<unknown>,
): JobDefinition {
  return defineJob({
    queue: QUEUES.moderation,
    name,
    description,
    data: z.object({}),
    schedule,
    attempts: 3,
    backoffMs: 5_000,
    handler: async (_data, ctx) => {
      const r = await withRunLock(
        ctx.valkey,
        moderationLockKey(name),
        { ttlMs: 30_000, maxHoldMs: maxRunMs, job: name, logger: ctx.logger },
        () => run(ctx),
      );
      moderationMetrics.runs.add(1, { job: name, outcome: r.acquired ? "ran" : "skipped" });
      return r.acquired ? r.value : { skipped: true };
    },
  });
}

/** Build, then deliver what this and earlier runs inserted (and retry failed deliveries). */
export async function sorBuildRun(ctx: WorkerContext) {
  const built = await buildStatements(ctx);
  const delivered = await deliverStatements(ctx);
  return { ...built, ...delivered };
}

export const sorJobs: readonly JobDefinition[] = [
  locked(
    MODERATION_JOBS.sorBuild,
    "Build and deliver statements of reasons from the audit log",
    { every: 15_000 },
    5 * 60_000,
    sorBuildRun,
  ),
  locked(
    MODERATION_JOBS.sorCoverage,
    "Daily: alert on enforcement actions with no statement of reasons",
    { pattern: "41 4 * * *" },
    30 * 60_000,
    sorCoverage,
  ),
];
