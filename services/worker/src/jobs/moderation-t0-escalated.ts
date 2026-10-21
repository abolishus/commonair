// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, ModerationT0EscalatedJob, QUEUES } from "@commonair/contracts/internal";
import { applyT0Escalated } from "../moderation/t0-escalated.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.t0Escalated,
  description: "Apply the full T0 actions to a human-escalated case a legal user confirmed",
  data: ModerationT0EscalatedJob,
  attempts: 20,
  backoffMs: 2_000,
  handler: async (data, ctx) => applyT0Escalated(ctx, data),
});
