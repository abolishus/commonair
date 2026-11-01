// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-broadcast audience rollup (W2-rollup-analytics, ADR 0014 decisions 1, 3; batch 6
 * decision (k)). Enqueued by the outbox relay `AUDIENCE_SETTLE_SECONDS` after `stream.offline`
 * (`reason: "offline"`), at once on `integrity.sessions.rescored` (`"rescore"`), and by the API test
 * hook (`"test"`, with `settleSeconds`). Re-runnable: it replaces the broadcast's rows and emits
 * `analytics.rollup.ready` in the same transaction, which starts the attestation job.
 *
 * Contract-step stub: it does nothing and reports `pending`, so the enqueue wiring can run before
 * the unit fills in the body.
 */
import { ANALYTICS_JOBS, type AnalyticsJobResult, BroadcastRollupJob, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.broadcastRollup,
  description: "Roll a settled broadcast's sessions up into per-minute audience, exclusion and cost rows",
  data: BroadcastRollupJob,
  handler: async (data, ctx): Promise<AnalyticsJobResult> => {
    ctx.logger.debug("broadcast-rollup is not implemented yet", { broadcastId: data.broadcastId, reason: data.reason });
    return { pending: 1 };
  },
});
