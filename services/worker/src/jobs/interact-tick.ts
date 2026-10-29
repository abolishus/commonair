// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E8-polls: end due polls, lock due predictions, throttled progress (`../interact/polls/tick.ts`). */
import { INTERACT_JOBS, InteractJob, QUEUES } from "@commonair/contracts/internal";
import { runInteractTick } from "../interact/polls/tick.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.interact,
  name: INTERACT_JOBS.tick,
  description: "Every 2 s: end due polls, lock due predictions, emit throttled progress events",
  data: InteractJob,
  schedule: { every: 2_000 },
  attempts: 1,
  handler: async (_data, ctx) => ({ ...(await runInteractTick(ctx.db, ctx.now())) }),
});
