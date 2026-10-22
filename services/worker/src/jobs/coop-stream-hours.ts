// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `COOP_JOBS.streamHours`: the integrity stream-hours pass on demand, for the co-op test hook
 * (`POST /internal/coop/tick`). It has no schedule: the integrity queue already runs it every
 * 5 minutes. It holds the integrity job's own run lock, so it never overlaps a scheduled run; a
 * tick that finds it busy waits briefly, then answers `skipped`.
 */
import { COOP_JOBS, CoopJob, QUEUES, type CoopJobResult } from "@commonair/contracts/internal";
import { INTEGRITY_SCHEDULES, RUN_LOCK_TTL_MS, runLockKey, runStreamHours } from "../integrity/jobs.ts";
import { withRunLock, type LockResult } from "../integrity/lock.ts";
import { COOP_LOCK_WAIT_MS, counts } from "../coop/job.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.coop,
  name: COOP_JOBS.streamHours,
  description: "Test hook only: run the integrity stream-hours pass now (scheduled on the integrity queue)",
  data: CoopJob,
  attempts: 1,
  handler: async (_data, ctx): Promise<CoopJobResult> => {
    const deadline = Date.now() + COOP_LOCK_WAIT_MS;
    let r: LockResult<Record<string, number>>;
    for (;;) {
      r = await withRunLock(
        ctx.valkey,
        runLockKey("stream-hours"),
        {
          ttlMs: RUN_LOCK_TTL_MS,
          maxHoldMs: INTEGRITY_SCHEDULES["stream-hours"].maxRunMs,
          job: COOP_JOBS.streamHours,
          logger: ctx.logger,
        },
        () => runStreamHours(ctx),
      );
      if (r.acquired || Date.now() >= deadline) break;
      await Bun.sleep(200);
    }
    return r.acquired ? counts(r.value) : { skipped: 1 };
  },
});
