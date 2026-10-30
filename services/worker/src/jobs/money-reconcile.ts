// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

/** feature-wins §4.1. Also enqueued on demand (empty data) by the ops test hook; a busy run lock answers `skipped`. */
export const job = defineJob({
  queue: QUEUES.payments,
  name: "money-reconcile",
  description: "Check each payment's ledger postings against its recorded breakdown",
  data: z.object({}),
  schedule: { pattern: "17 3 * * *" },
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:payments:money-reconcile",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: "money-reconcile", logger: ctx.logger },
      // Stub: W1-breakdown implements it.
      async () => ({ payments: 0, mismatches: 0 }),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
