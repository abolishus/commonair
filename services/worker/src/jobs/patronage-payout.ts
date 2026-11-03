// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** One member's patronage payout for an approved period (`patronagePayoutJobId`). M1-coop-money fills it. */
import { B8_JOBS, PatronagePayoutJob, QUEUES } from "@commonair/contracts/internal";
import { b8Stub } from "../b8/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.payments,
  name: B8_JOBS.patronagePayout,
  description: "Pay one member's patronage dividend for an approved period",
  data: PatronagePayoutJob,
  handler: b8Stub(B8_JOBS.patronagePayout),
});
