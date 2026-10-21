// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, ModerationScanJob, QUEUES } from "@commonair/contracts/internal";
import { scanFrame } from "../moderation/scan.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.scan,
  description: "Classify one sampled live frame and apply T1 (restrict and queue) or T2 (mature label)",
  data: ModerationScanJob,
  // The frame expires from Valkey in 60 s, so late retries only count it as expired.
  attempts: 3,
  backoffMs: 2_000,
  handler: async (data, ctx) => scanFrame(ctx, data),
});
