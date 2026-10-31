// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Channel points for gate-eligible watch time (ADR 0026 decision 1); the work is in `interact/points`. */
import { INTERACT_JOBS, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { accruePoints } from "../interact/points/accrue.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: INTERACT_JOBS.pointsAccrue,
  description: "Every 60 s: credit channel points for gate-eligible watch time (ADR 0026 decision 1)",
  data: InteractJob,
  schedule: { every: 60_000 },
  attempts: 1,
  handler: async (_data, ctx) => {
    const r = await accruePoints(ctx, { includeDemo: ctx.demoSeedFull === true });
    return { viewers: r.viewers, points: r.points };
  },
});
