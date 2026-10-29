// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Owned by E8-polls; the contract step registered it with its final schedule and a no-op handler. */
import { INTERACT_JOBS, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: INTERACT_JOBS.tick,
  description: "Every 2 s: end due polls, lock due predictions, emit throttled progress events",
  data: InteractJob,
  schedule: { every: 2_000 },
  attempts: 1,
  handler: async () => ({ pollsEnded: 0, predictionsLocked: 0, progress: 0 }),
});
