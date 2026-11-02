// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MoneyReleaseHoldsJob, QUEUES } from "@commonair/contracts/internal";
import { releaseHolds } from "../money/holds.ts";
import { MONEY_JOBS, withMoneyLock } from "../money/job.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.payments,
  name: MONEY_JOBS.releaseHolds,
  description: "Move creator shares past the payout.rules hold from creator-hold to available",
  data: MoneyReleaseHoldsJob,
  schedule: { pattern: "41 * * * *" },
  attempts: 3,
  backoffMs: 10_000,
  handler: async (data, ctx) =>
    withMoneyLock(ctx, MONEY_JOBS.releaseHolds, 20 * 60_000, async () => {
      // Test-only data (the ops hook): honoured only while this worker runs OPS_TEST_HOOKS.
      const holdDays = ctx.opsTestHooks ? data.holdDays : undefined;
      if (data.holdDays !== undefined && holdDays === undefined)
        ctx.logger.warn("money-release-holds ignored holdDays: OPS_TEST_HOOKS is off");
      return { ...(await releaseHolds(ctx, holdDays === undefined ? {} : { holdDays })) };
    }),
});
