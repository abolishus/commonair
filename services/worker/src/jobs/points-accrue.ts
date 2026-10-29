// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Owned by E8-points; the contract step registered it with its final schedule and a no-op handler. */
import { INTERACT_JOBS, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: INTERACT_JOBS.pointsAccrue,
  description: "Every 60 s: credit channel points for gate-eligible watch time (ADR 0026 decision 1)",
  data: InteractJob,
  schedule: { every: 60_000 },
  attempts: 1,
  handler: async () => ({ viewers: 0, points: 0 }),
});
