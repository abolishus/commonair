// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Daily: rotate actor keys older than `FEDERATION_RULES.keyRotateDays` (the yearly rotation); with
 * a `channelId` (an admin rotation), send `Update{Service}` with the new key (ADR 0030 decision 4).
 */
import { FEDERATION_JOBS, FederationRotateJob, QUEUES } from "@commonair/contracts/internal";
import { federationConfig } from "../federation/config.ts";
import { runRotate } from "../federation/rotate.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.rotate,
  description: "Daily: rotate actor keys older than the rotation age",
  data: FederationRotateJob,
  schedule: { pattern: "37 4 * * *" },
  handler: async (data, ctx) => ({ ...(await runRotate(data, ctx, federationConfig(ctx))) }),
});
