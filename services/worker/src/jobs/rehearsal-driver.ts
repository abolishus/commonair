// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The rehearsal driver (W2-rehearsal, batch 6 decisions (f), (g), (h)): one job per arm, enqueued
 * by the outbox relay on `rehearsal.armed` (job id `rehearsal-<armId>`). It waits for the rehearsal
 * broadcast, runs `@commonair/sim` chat through the chat dry run, samples ingest health, enforces
 * the 30-minute cap and writes `KEYS.rehearsalReport` every few seconds.
 *
 * Contract-step stub: it does nothing and reports `pending`.
 */
import { QUEUES, REHEARSAL_JOBS, RehearsalDriverJob } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.rehearsal,
  name: REHEARSAL_JOBS.driver,
  description: "Drive an armed rehearsal: simulated chat, ingest checks, the duration cap and the report",
  data: RehearsalDriverJob,
  handler: async (data, ctx): Promise<Record<string, number>> => {
    ctx.logger.debug("rehearsal-driver is not implemented yet", { armId: data.armId, channelId: data.channelId });
    return { pending: 1 };
  },
});
