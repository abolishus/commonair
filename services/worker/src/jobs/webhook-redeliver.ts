// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { redeliver } from "../webhooks/deliver.ts";
import { RedeliverJob, WEBHOOK_JOBS } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.webhooks,
  name: WEBHOOK_JOBS.redeliver,
  description: "Re-send a logged notification once with the same message id",
  data: RedeliverJob,
  attempts: 1,
  handler: async ({ deliveryId }, ctx) => ({ result: await redeliver(ctx, deliveryId) }),
});
