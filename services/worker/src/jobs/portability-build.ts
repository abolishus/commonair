// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `PORTABILITY_JOBS.build`: a `bundle` export, through the shared export pipeline (`buildExport`:
 * claim, build, upload, TTL, mail). `portability.bundle.create` enqueues it with the export id as
 * the job id; the bundle itself is built by `exports/bundle.ts`.
 */
import { PORTABILITY_JOBS, PortabilityBuildJob, QUEUES } from "@commonair/contracts/internal";
import { buildExport } from "../exports/build.ts";
import { defineJob } from "../runtime/registry.ts";

const ATTEMPTS = 3;

export const job = defineJob({
  queue: QUEUES.portability,
  name: PORTABILITY_JOBS.build,
  description: "Build a portability bundle export, upload it and mail the owner a link",
  data: PortabilityBuildJob,
  attempts: ATTEMPTS,
  backoffMs: 15_000,
  handler: async ({ exportId }, ctx, meta) =>
    buildExport(ctx, exportId, { lastAttempt: meta.attemptsMade + 1 >= ATTEMPTS }),
});
