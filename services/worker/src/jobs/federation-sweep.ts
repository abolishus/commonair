// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Daily: drop old inbox items and failing inboxes, and tell followers of channels turned off (ADR 0030). */
import { FEDERATION_JOBS, FederationSweepJob, QUEUES } from "@commonair/contracts/internal";
import { federationConfig } from "../federation/config.ts";
import { runSweep } from "../federation/sweep.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.sweep,
  description: "Daily: drop old inbox items and inboxes failing for too long",
  data: FederationSweepJob,
  schedule: { pattern: "47 4 * * *" },
  handler: async (_data, ctx) => ({ ...(await runSweep(ctx, federationConfig(ctx))) }),
});
