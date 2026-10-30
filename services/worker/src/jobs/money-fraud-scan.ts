// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0036. Also enqueued on demand (empty data) by the ops test hook; a busy run lock answers `skipped`. */
export const job = defineJob({
  queue: QUEUES.payments,
  name: "money-fraud-scan",
  description: "Flag payees whose payments match the fraud rules and hold their payouts",
  data: z.object({}),
  schedule: { every: 900_000 },
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:payments:money-fraud-scan",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: "money-fraud-scan", logger: ctx.logger },
      // Stub: W1-fraud-floor implements it.
      async () => ({ flagged: 0, held: 0 }),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
