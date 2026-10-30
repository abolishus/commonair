// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DiscordJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { DISCORD_BACKOFF_MS, productionTransport, runDiscordJob } from "../notify/discord/job.ts";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0028 decision 5: post a go-live (or the studio's test) to a channel's Discord webhook. */
export const job = defineJob({
  queue: QUEUES.notifications,
  name: NOTIFY_JOBS.discord,
  description: "Post a go-live message to a channel's Discord webhook",
  data: DiscordJob,
  attempts: 5,
  backoffMs: DISCORD_BACKOFF_MS,
  // Always the full SSRF guard: no loopback, no private addresses, no extra CA.
  handler: (data, ctx, meta) => runDiscordJob(data, ctx, productionTransport(ctx), meta),
});
