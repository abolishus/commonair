// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { enforceVodRetention } from "../housekeeping.ts";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

/** Also enqueued on demand (empty data) by the ops test hook; a busy run lock answers `skipped`. */
export const job = defineJob({
  queue: QUEUES.retention,
  name: "vod-retention",
  description: "Delete expired and removed VODs' and removed clips' objects (unless held) and mark them deleted",
  data: z.object({}),
  schedule: { pattern: "27 * * * *" },
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:retention:vod-retention",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: "vod-retention", logger: ctx.logger },
      () => enforceVodRetention(ctx),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
