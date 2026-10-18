// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { pruneWebhookDeliveries } from "../housekeeping.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.retention,
  name: "prune-webhook-deliveries",
  description: "Delete webhook delivery log rows older than 30 days",
  data: z.object({}),
  schedule: { pattern: "17 3 * * *" },
  handler: async (_data, ctx) => pruneWebhookDeliveries(ctx),
});
