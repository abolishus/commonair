// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Monthly: draw the advisory jury panel and its cases (ADR 0038; `src/jury/draw.ts`). Also the harness hook. */
import { JURY_JOBS, JuryDrawJob, QUEUES } from "@commonair/contracts/internal";
import { runDraw } from "../jury/draw.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.jury,
  name: JURY_JOBS.draw,
  description: "Monthly: draw the advisory jury panel and its cases",
  data: JuryDrawJob,
  schedule: { pattern: "11 6 1 * *" },
  attempts: 3,
  backoffMs: 30_000,
  handler: (_data, ctx) => runDraw(ctx),
});
