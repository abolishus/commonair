// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NOTIFY_JOBS, NotifyPruneJob, QUEUES } from "@commonair/contracts/internal";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { defineJob } from "../runtime/registry.ts";

/**
 * `notifications` retention (decided 2026-10-30): rows older than `NOTIFY_RULES.retentionDays`,
 * read `go_live` rows older than `readGoLiveRetentionDays`, in batches. Also run now by the ops
 * test hook.
 */
export const job = defineJob({
  queue: QUEUES.retention,
  name: NOTIFY_JOBS.prune,
  description: "Delete old notifications",
  data: NotifyPruneJob,
  schedule: { every: NOTIFY_RULES.pruneEveryMs },
  attempts: 1,
  // Stub: N1-fanout implements it.
  handler: async () => ({ deleted: 0, readGoLive: 0 }),
});
