// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXPORT_JOBS, ExportBuildJob, QUEUES } from "@commonair/contracts/internal";
import { buildExport } from "../exports/build.ts";
import { defineJob } from "../runtime/registry.ts";

const ATTEMPTS = 3;

export const job = defineJob({
  queue: QUEUES.exports,
  name: EXPORT_JOBS.build,
  description: "Build a data export archive, upload it and mail the user a link (enqueued by me.exports.create)",
  data: ExportBuildJob,
  attempts: ATTEMPTS,
  backoffMs: 15_000,
  handler: async ({ exportId }, ctx, meta) =>
    buildExport(ctx, exportId, { lastAttempt: meta.attemptsMade + 1 >= ATTEMPTS }),
});
