// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EXPORT_JOBS, QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { cleanupExports } from "../exports/build.ts";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

/** Also enqueued on demand (empty data) by the ops test hook; a busy run lock answers `skipped`. */
export const job = defineJob({
  queue: QUEUES.exports,
  name: EXPORT_JOBS.cleanup,
  description: "Delete data export archives past their expiry and mark the exports expired",
  data: z.object({}),
  schedule: { pattern: "17 * * * *" },
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:exports:export-cleanup",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: EXPORT_JOBS.cleanup, logger: ctx.logger },
      () => cleanupExports(ctx),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
