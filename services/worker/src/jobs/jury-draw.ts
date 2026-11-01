// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Monthly: draw the advisory jury panel and its cases. Owned by W3-jury; a no-op stub until it lands (batch 7 contract step §5.1). */
import { JURY_JOBS, JuryDrawJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.jury,
  name: JURY_JOBS.draw,
  description: "Monthly: draw the advisory jury panel and its cases",
  data: JuryDrawJob,
  schedule: { pattern: "11 6 1 * *" },
  handler: stubHandler(JURY_JOBS.draw),
});
