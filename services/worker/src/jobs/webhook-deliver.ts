// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { deliver } from "../webhooks/deliver.ts";
import { DeliverJob, WEBHOOK_JOBS } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.webhooks,
  name: WEBHOOK_JOBS.deliver,
  description: "One signed notification attempt; schedules the next attempt with backoff on failure",
  data: DeliverJob,
  handler: async (data, ctx) => ({ result: await deliver(ctx, data) }),
});
