// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { verifyCallback } from "../webhooks/deliver.ts";
import { VerifyCallbackJob, WEBHOOK_JOBS } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.webhooks,
  name: WEBHOOK_JOBS.verifyCallback,
  description: "Challenge a new webhook callback; enables or fails the subscription",
  data: VerifyCallbackJob,
  // A second challenge would race the first; the API can enqueue again if needed.
  attempts: 1,
  handler: async ({ subscriptionId }, ctx) => ({ status: await verifyCallback(ctx, subscriptionId) }),
});
