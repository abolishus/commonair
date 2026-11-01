// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Signed audience attestations (W2b-attestations, ADR 0014; batch 6 decisions (l), (r)): append a
 * `broadcast` or `supersede` entry to the channel's chain from the broadcast's rollup, signed with
 * `INTEGRITY_SIGNING_KEY` (worker only). Enqueued by the outbox relay on `analytics.rollup.ready`
 * (`reason` `rollup` / `recheck` / `test`), by the daily `attestation-reconcile` pass below
 * (`reconcile`), and by the API test hook (`test`).
 *
 * Contract-step stubs: both jobs do nothing and report `pending`; the schedule is live.
 */
import {
  ANALYTICS_JOBS,
  type AnalyticsJobResult,
  AttestationReconcileJob,
  IntegrityAttestationJob,
  QUEUES,
} from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.integrityAttestation,
  description: "Append a signed attestation for a rolled-up broadcast when its figures are new or changed",
  data: IntegrityAttestationJob,
  handler: async (data, ctx): Promise<AnalyticsJobResult> => {
    ctx.logger.debug("integrity-attestation is not implemented yet", {
      broadcastId: data.broadcastId,
      reason: data.reason,
    });
    return { pending: 1 };
  },
});

/** Daily: re-check broadcasts re-scored or re-rolled after their latest attestation entry. */
export const reconcileJob = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.attestationReconcile,
  description: "Re-check broadcasts whose rollup changed after their latest attestation entry",
  data: AttestationReconcileJob,
  schedule: { pattern: "41 4 * * *" },
  handler: async (_data, ctx): Promise<AnalyticsJobResult> => {
    ctx.logger.debug("attestation-reconcile is not implemented yet");
    return { pending: 1 };
  },
});
