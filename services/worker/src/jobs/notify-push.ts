// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { NOTIFY_JOBS, PushJob, QUEUES } from "@commonair/contracts/internal";
import { runPushJob } from "../notify/push/job.ts";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0028 decisions 1 and 6: send one go-live to every push subscription of one member (RFC 8030/8291/8292). */
export const job = defineJob({
  queue: QUEUES.notifications,
  name: NOTIFY_JOBS.push,
  description: "Send a go-live web push to one member's browsers",
  data: PushJob,
  attempts: 4,
  backoffMs: 30_000,
  handler: (data, ctx, meta) => runPushJob(ctx, data, meta),
});
