// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, ModerationT0Job, QUEUES } from "@commonair/contracts/internal";
import { handleT0 } from "../moderation/t0.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.t0,
  description: "Apply the T0 transaction for a hash-list match (suspend, hide, hold, evidence, NCMEC draft)",
  data: ModerationT0Job,
  // Retried until it lands: in-process retries per attempt, then BullMQ's exponential backoff
  // from 2 s (weeks in total). Every exhausted attempt logs a fatal alert with ids.
  attempts: 20,
  backoffMs: 2_000,
  handler: async (data, ctx, meta) => handleT0(ctx, data, meta),
});
