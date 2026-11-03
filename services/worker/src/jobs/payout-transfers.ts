// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One Stripe payout's Connect transfer, enqueued by a payout run with `payoutTransferJobId` (M1-connect,
 * `money/transfers.ts`). An unknown outcome throws, so BullMQ retries with the same idempotency key;
 * the last attempt marks the transfer `outcome_unknown` first.
 */
import { B8_JOBS, PayoutTransferJob, QUEUES } from "@commonair/contracts/internal";
import { PAYOUT_TRANSFER_ATTEMPTS, PAYOUT_TRANSFER_BACKOFF_MS } from "@commonair/ledger";
import { runPayoutTransfer, transferAdapterFromEnv } from "../money/transfers.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.payments,
  name: B8_JOBS.payoutTransfers,
  description: "Create the Connect transfer for one scheduled Stripe payout",
  data: PayoutTransferJob,
  attempts: PAYOUT_TRANSFER_ATTEMPTS,
  backoffMs: PAYOUT_TRANSFER_BACKOFF_MS,
  handler: (data, ctx, meta) =>
    runPayoutTransfer(ctx, { adapter: transferAdapterFromEnv() }, data.payoutId, {
      lastAttempt: meta.attemptsMade + 1 >= PAYOUT_TRANSFER_ATTEMPTS,
    }),
});
