// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Write relay_purges rows for one media-state, suspension, restriction or offline event. Owned by W3-dvr-relay; a no-op stub until it lands (batch 7 contract step §5.1). */
import { RELAY_PURGE_JOBS, RelayPurgeEmitJob, QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.relayPurge,
  name: RELAY_PURGE_JOBS.emit,
  description: "Write relay_purges rows for one media-state, suspension, restriction or offline event",
  data: RelayPurgeEmitJob,
  handler: stubHandler(RELAY_PURGE_JOBS.emit),
});

/** Daily: drop `relay_purges` rows older than 7 days (ADR 0016 Amendment 1). Also W3-dvr-relay's. */
export const cleanupJob = defineJob({
  queue: QUEUES.relayPurge,
  name: `${RELAY_PURGE_JOBS.emit}-cleanup`,
  description: "Daily: drop relay purge rows older than 7 days",
  data: z.object({}),
  schedule: { pattern: "53 3 * * *" },
  handler: stubHandler(`${RELAY_PURGE_JOBS.emit}-cleanup`),
});
