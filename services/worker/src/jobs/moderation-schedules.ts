// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The recurring trust & safety jobs, each under a Valkey run lock so replicas never overlap. */
import { MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { withRunLock } from "../integrity/lock.ts";
import { runEvidenceAudit } from "../moderation/evidence-audit.ts";
import { moderationMetrics } from "../moderation/metrics.ts";
import {
  frameRetention,
  holdEligibility,
  incomingCleanup,
  ncmecUnfiled,
  reconcileT0Media,
} from "../moderation/schedules.ts";
import { defineJob, type JobDefinition, type Schedule } from "../runtime/registry.ts";

export const moderationLockKey = (name: string) => `worker:lock:moderation:${name}`;

function scheduled(
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
    backoffMs: 30_000,
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

export const moderationSchedules: readonly JobDefinition[] = [
  scheduled(
    MODERATION_JOBS.evidenceAudit,
    "Daily: retry unfinished T0 media preservation and verify every evidence object digest",
    { pattern: "17 3 * * *" },
    6 * 3_600_000,
    async (ctx) => {
      const t0Media = await reconcileT0Media(ctx);
      const evidence = await runEvidenceAudit(ctx);
      return { t0Media, evidence };
    },
  ),
  scheduled(
    MODERATION_JOBS.ncmecUnfiled,
    "Hourly: alert on NCMEC drafts unfiled after 24 h, open an incident after 72 h",
    { pattern: "7 * * * *" },
    10 * 60_000,
    ncmecUnfiled,
  ),
  scheduled(
    MODERATION_JOBS.holdEligibility,
    "Daily: mark holds eligible for release one year after their report was filed",
    { pattern: "37 2 * * *" },
    10 * 60_000,
    holdEligibility,
  ),
  scheduled(
    MODERATION_JOBS.frameRetention,
    "Daily: delete T1/T2 review frames 30 days after their case closed",
    { pattern: "47 2 * * *" },
    60 * 60_000,
    (ctx) => frameRetention(ctx),
  ),
  scheduled(
    MODERATION_JOBS.incomingCleanup,
    "Hourly: delete objects under the incoming upload prefix older than 24 h",
    { pattern: "23 * * * *" },
    30 * 60_000,
    incomingCleanup,
  ),
];
