// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { enforceChatRetention } from "../chat/retention.ts";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0012 amendment 1 decision 6. Also enqueued on demand (empty data) by the ops test hook; a busy run lock answers `skipped`. */
export const job = defineJob({
  queue: QUEUES.retention,
  name: "chat-retention",
  description: "Delete chat past its retention window (unless held)",
  data: z.object({}),
  schedule: { pattern: "41 * * * *" },
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:retention:chat-retention",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: "chat-retention", logger: ctx.logger },
      () => enforceChatRetention(ctx),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
