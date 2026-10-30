// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { runSurgeGuard } from "../chat-gate/surge.ts";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0015 decision 6. Also enqueued on demand (empty data) by the ops test hook; a busy run lock answers `skipped`. */
export const job = defineJob({
  queue: QUEUES.moderation,
  name: "chat-surge-guard",
  description: "Start and end surge mode on channels with the surge guard enabled",
  data: z.object({}),
  schedule: { every: 30_000 },
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:moderation:chat-surge-guard",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: "chat-surge-guard", logger: ctx.logger },
      () => runSurgeGuard(ctx),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
