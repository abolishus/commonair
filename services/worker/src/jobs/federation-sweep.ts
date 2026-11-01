// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Daily: drop old inbox items and inboxes failing for too long. Owned by N4-delivery; a no-op stub until it lands (batch 7 contract step §5.1). */
import { FEDERATION_JOBS, FederationSweepJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.sweep,
  description: "Daily: drop old inbox items and inboxes failing for too long",
  data: FederationSweepJob,
  schedule: { pattern: "47 4 * * *" },
  handler: stubHandler(FEDERATION_JOBS.sweep),
});
