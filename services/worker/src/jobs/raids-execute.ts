// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Owned by E8-raids-goals; the contract step registered it with its final schedule and a no-op handler. */
import { INTERACT_JOBS, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: INTERACT_JOBS.raidsExecute,
  description: "Every 2 s: execute or cancel raids whose countdown ended",
  data: InteractJob,
  schedule: { every: 2_000 },
  attempts: 1,
  handler: async () => ({ executed: 0, canceled: 0 }),
});
