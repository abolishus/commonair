// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { sweepVodReadyEmails, VOD_EMAIL_SWEEP_MS } from "../notify/vod/email.ts";
import { defineJob } from "../runtime/registry.ts";

/** The job's name; only the worker schedules it, so it is not in the shared contract. */
export const VOD_EMAIL_JOB = "notify-vod-email";

/** Overhaul wave 4 (D7.3): "Your video is ready" by email for creators who turned it on. */
export const job = defineJob({
  queue: QUEUES.email,
  name: VOD_EMAIL_JOB,
  description: "Email creators whose video is ready, if they asked for it",
  data: z.object({}),
  schedule: { every: VOD_EMAIL_SWEEP_MS },
  // Not retried: the next sweep, a minute later, sees the same rows.
  attempts: 1,
  handler: async (_data, ctx) => sweepVodReadyEmails(ctx),
});
