// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Delete failed and abandoned `incoming/portability/` archives (decision (i), `portability/incoming-cleanup.ts`). */
import { B8_JOBS, PortabilityIncomingCleanupJob, QUEUES } from "@commonair/contracts/internal";
import { cleanIncomingArchives } from "../portability/incoming-cleanup.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: B8_JOBS.incomingCleanup,
  description: "Delete failed and abandoned incoming portability archives",
  data: PortabilityIncomingCleanupJob,
  schedule: { pattern: "13 4 * * *" },
  handler: async (_data, ctx) => ({ ...(await cleanIncomingArchives(ctx)) }),
});
