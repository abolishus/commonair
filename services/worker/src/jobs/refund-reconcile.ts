// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Settle treasurer refund requests whose outcome is unknown (ADR 0007 decision 3). M1-gifts-refunds fills it. */
import { B8_JOBS, QUEUES, RefundReconcileJob } from "@commonair/contracts/internal";
import { b8Stub } from "../b8/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.payments,
  name: B8_JOBS.refundReconcile,
  description: "Ask the provider for the outcome of refunds whose submission went unanswered",
  data: RefundReconcileJob,
  schedule: { pattern: "*/15 * * * *" },
  handler: b8Stub(B8_JOBS.refundReconcile),
});
