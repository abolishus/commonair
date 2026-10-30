// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NOTIFY_JOBS, NotifyPruneJob, QUEUES } from "@commonair/contracts/internal";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { withRunLock } from "../integrity/lock.ts";
import { pruneNotifications } from "../notify/prune/prune.ts";
import { defineJob } from "../runtime/registry.ts";

export const NOTIFY_PRUNE_LOCK_KEY = "worker:lock:retention:notify-prune";

/**
 * `notifications` retention (decided 2026-10-30): rows older than `NOTIFY_RULES.retentionDays`,
 * read `go_live` rows older than `readGoLiveRetentionDays`, in batches. Also run now by the ops
 * test hook. A run lock keeps two replicas apart; a busy lock answers `skipped`.
 */
export const job = defineJob({
  queue: QUEUES.retention,
  name: NOTIFY_JOBS.prune,
  description: "Delete old notifications",
  data: NotifyPruneJob,
  schedule: { every: NOTIFY_RULES.pruneEveryMs },
  attempts: 1,
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      NOTIFY_PRUNE_LOCK_KEY,
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: NOTIFY_JOBS.prune, logger: ctx.logger },
      () => pruneNotifications(ctx),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
