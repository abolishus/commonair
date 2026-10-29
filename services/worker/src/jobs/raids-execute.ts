// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Execute or cancel raids whose countdown ended (ADR 0026 decision 4). Owned by E8-raids-goals. */
import { INTERACT_JOBS, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { executeDueRaids } from "../interact/raids/execute.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: INTERACT_JOBS.raidsExecute,
  description: "Every 2 s: execute or cancel raids whose countdown ended",
  data: InteractJob,
  schedule: { every: 2_000 },
  attempts: 1,
  handler: async (_data, ctx) => ({ ...(await executeDueRaids(ctx)) }),
});
