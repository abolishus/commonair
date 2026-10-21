// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, NciiClockJob, QUEUES } from "@commonair/contracts/internal";
import { nciiClock } from "../moderation/ncii-clock.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.nciiClock,
  description: "NCII 48-hour clock: escalate at 24 h and 36 h, hide undecided requests at the deadline",
  data: NciiClockJob,
  schedule: { every: 60_000 },
  attempts: 3,
  backoffMs: 5_000,
  handler: async (data, ctx) => nciiClock(ctx, data),
});
