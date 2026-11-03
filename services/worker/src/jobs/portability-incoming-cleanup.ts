// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Delete failed and abandoned `incoming/portability/` archives (decision (i)). B8-server fills it. */
import { B8_JOBS, PortabilityIncomingCleanupJob, QUEUES } from "@commonair/contracts/internal";
import { b8Stub } from "../b8/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: B8_JOBS.incomingCleanup,
  description: "Delete failed and abandoned incoming portability archives",
  data: PortabilityIncomingCleanupJob,
  schedule: { pattern: "13 4 * * *" },
  handler: b8Stub(B8_JOBS.incomingCleanup),
});
