// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settle refund requests whose outcome is unknown, and make the automatic refunds of money booked
 * for ended subscriptions that the API's after-commit hook missed (ADR 0007 decisions 2 and 3;
 * `money/refund-reconcile.ts`). Under a run lock, as the other money jobs.
 */
import { B8_JOBS, QUEUES, RefundReconcileJob } from "@commonair/contracts/internal";
import { withRunLock } from "../integrity/lock.ts";
import { MONEY_LOCK_TTL_MS } from "../money/job.ts";
import { moneyMetrics } from "../money/metrics.ts";
import { type RefundPort, refundPortFromEnv, runRefundReconcile } from "../money/refund-reconcile.ts";
import { defineJob } from "../runtime/registry.ts";

const MAX_RUN_MS = 5 * 60_000;
export const REFUND_RECONCILE_LOCK = `worker:lock:money:${B8_JOBS.refundReconcile}`;

let port: RefundPort | undefined;
/** The provider port, built once per process (tests pass their own to `runRefundReconcile`). */
const portOf = () => (port ??= refundPortFromEnv());

export const job = defineJob({
  queue: QUEUES.payments,
  name: B8_JOBS.refundReconcile,
  description: "Ask the provider for the outcome of refunds whose submission went unanswered",
  data: RefundReconcileJob,
  schedule: { pattern: "*/15 * * * *" },
  attempts: 3,
  backoffMs: 10_000,
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      REFUND_RECONCILE_LOCK,
      { ttlMs: MONEY_LOCK_TTL_MS, maxHoldMs: MAX_RUN_MS, job: B8_JOBS.refundReconcile, logger: ctx.logger },
      () => runRefundReconcile(ctx, portOf()),
    );
    moneyMetrics.runs.add(1, { job: B8_JOBS.refundReconcile, outcome: r.acquired ? "ran" : "skipped" });
    return r.acquired ? r.value : { skipped: true };
  },
});
