// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { sendTestEvent } from "../webhooks/deliver.ts";
import { TestEventJob, WEBHOOK_JOBS } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.webhooks,
  name: WEBHOOK_JOBS.testEvent,
  description: "Deliver a synthesized, catalog-valid sample event once",
  data: TestEventJob,
  attempts: 1,
  handler: async ({ subscriptionId, eventId }, ctx) => ({ result: await sendTestEvent(ctx, subscriptionId, eventId) }),
});
