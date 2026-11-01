// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay purges (batch 7 decision (x), ADR 0016 Amendment 1): `relay-purge` writes the
 * `relay_purges` rows for one media-state, restriction, suspension or offline event and nudges
 * the feed (`src/relay-purge/emit.ts`); `relay-purge-cleanup` drops rows past 7 days daily and
 * records the deleted-seq watermark (`src/relay-purge/cleanup.ts`).
 */
import { RELAY_PURGE_JOBS, RelayPurgeEmitJob, QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { cleanupPurges } from "../relay-purge/cleanup.ts";
import { emitPurges, nudge } from "../relay-purge/emit.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.relayPurge,
  name: RELAY_PURGE_JOBS.emit,
  description: "Write relay_purges rows for one media-state, suspension, restriction or offline event",
  data: RelayPurgeEmitJob,
  attempts: 5,
  backoffMs: 2_000,
  handler: async (data, ctx) => {
    const r = await emitPurges(ctx, data.eventId);
    if (r.written > 0) await nudge(ctx);
    return r;
  },
});

/** Daily: drop `relay_purges` rows older than 7 days and record the watermark (ADR 0016 Amendment 1). */
export const cleanupJob = defineJob({
  queue: QUEUES.relayPurge,
  name: `${RELAY_PURGE_JOBS.emit}-cleanup`,
  description: "Daily: drop relay purge rows older than 7 days",
  data: z.object({}),
  schedule: { pattern: "53 3 * * *" },
  handler: async (_data, ctx) => ({ ...(await cleanupPurges(ctx)) }),
});
