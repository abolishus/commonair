// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DiscordJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0028 decision 5: post a go-live (or the studio's test) to a channel's Discord webhook. */
export const job = defineJob({
  queue: QUEUES.notifications,
  name: NOTIFY_JOBS.discord,
  description: "Post a go-live message to a channel's Discord webhook",
  data: DiscordJob,
  attempts: 5,
  backoffMs: 60_000,
  // Stub: N1-discord implements it.
  handler: async () => ({ posted: 0 }),
});
