// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { runWeeklyDigest } from "../notify/weekly/digest.ts";
import { defineJob } from "../runtime/registry.ts";

/** The job's name; only the worker schedules it, so it is not in the shared contract. */
export const WEEKLY_DIGEST_JOB = "notify-weekly-digest";

/**
 * Overhaul wave 4 (D7.3): the opt-in weekly "What you missed" email. Hourly; it sends only in the
 * `DIGEST_RULES` window, and the per-member, per-week claim makes every run after the first a no-op.
 */
export const job = defineJob({
  queue: QUEUES.email,
  name: WEEKLY_DIGEST_JOB,
  description: "Send the weekly What you missed email to opted-in members",
  data: z.object({}),
  schedule: { pattern: "7 * * * *" },
  // Not retried: the next hourly run picks up whoever was not claimed.
  attempts: 1,
  handler: async (_data, ctx) => runWeeklyDigest(ctx),
});
