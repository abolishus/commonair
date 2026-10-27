// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DmcaRestoreJob, type DmcaRestoreResult, MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

/** Stub from the E7 contract step; E7-dmca owns this file and implements it. */
export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.dmcaRestore,
  description: "DMCA: restore countered content whose waiting period ended (no suit filed)",
  data: DmcaRestoreJob,
  schedule: { every: 900_000 },
  attempts: 3,
  handler: async (): Promise<DmcaRestoreResult> => ({ restored: 0, counters: 0 }),
});
