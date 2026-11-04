// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One member's Connect patronage payout for an approved period, enqueued by `coop.patronage.pay`
 * with `patronagePayoutJobId` (M1-coop-money, `coop/patronage-payout.ts`). An unknown outcome
 * throws, so BullMQ retries under the same key; the last attempt leaves a marker for the treasurer.
 */
import { B8_JOBS, PatronagePayoutJob, QUEUES } from "@commonair/contracts/internal";
import { transferAdapterFromEnv } from "../money/transfers.ts";
import { runPatronagePayout } from "../coop/patronage-payout.ts";
import { defineJob } from "../runtime/registry.ts";

/** As the API's producer (`coop/patronage-payouts.ts`): six attempts, 30 s exponential backoff. */
export const PATRONAGE_PAYOUT_ATTEMPTS = 6;
export const PATRONAGE_PAYOUT_BACKOFF_MS = 30_000;

export const job = defineJob({
  queue: QUEUES.payments,
  name: B8_JOBS.patronagePayout,
  description: "Pay one member's patronage dividend for an approved period",
  data: PatronagePayoutJob,
  attempts: PATRONAGE_PAYOUT_ATTEMPTS,
  backoffMs: PATRONAGE_PAYOUT_BACKOFF_MS,
  handler: (data, ctx, meta) =>
    runPatronagePayout(ctx, { adapter: transferAdapterFromEnv() }, data, {
      lastAttempt: meta.attemptsMade + 1 >= PATRONAGE_PAYOUT_ATTEMPTS,
    }),
});
