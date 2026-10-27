// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DmcaRestoreJob, MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { dmcaRestore } from "../dmca/restore.ts";
import { defineJob } from "../runtime/registry.ts";

/** E7-dmca: every 15 minutes, and on demand from the `dmca-tick` test hook (`asOf`). */
export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.dmcaRestore,
  description: "DMCA: restore countered content whose waiting period ended (no suit filed)",
  data: DmcaRestoreJob,
  schedule: { every: 900_000 },
  attempts: 3,
  handler: async (data, ctx) => dmcaRestore(ctx, data),
});
