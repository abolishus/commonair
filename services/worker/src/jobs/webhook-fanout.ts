// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { fanOut } from "../webhooks/deliver.ts";
import { FanoutJob, WEBHOOK_JOBS } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.webhooks,
  name: WEBHOOK_JOBS.fanout,
  description: "Match an outbox event against enabled webhook subscriptions and enqueue deliveries",
  data: FanoutJob,
  handler: async ({ eventId }, ctx) => ({ queued: await fanOut(ctx, eventId) }),
});
