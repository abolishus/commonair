// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** One Stripe payout's Connect transfer, enqueued by a payout run (`payoutTransferJobId`). M1-connect fills it. */
import { B8_JOBS, PayoutTransferJob, QUEUES } from "@commonair/contracts/internal";
import { b8Stub } from "../b8/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.payments,
  name: B8_JOBS.payoutTransfers,
  description: "Create the Connect transfer for one scheduled Stripe payout",
  data: PayoutTransferJob,
  handler: b8Stub(B8_JOBS.payoutTransfers),
});
