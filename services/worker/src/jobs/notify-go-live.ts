// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GoLiveJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

/**
 * ADR 0028 decision 8: one page of a channel's notifying followers per `stream.online` (enqueued by
 * the outbox relay, `notify/outbox-jobs.ts`); writes the in-app rows, queues the digest email and
 * enqueues push jobs and the next page.
 */
export const job = defineJob({
  queue: QUEUES.notifications,
  name: NOTIFY_JOBS.goLive,
  description: "Notify one page of a channel's followers that it went live",
  data: GoLiveJob,
  attempts: 5,
  // Stub: N1-fanout implements it.
  handler: async () => ({ followers: 0, inApp: 0, email: 0, push: 0, cooledDown: 0, nextPage: false }),
});
