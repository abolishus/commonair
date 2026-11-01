// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Close a jury panel: reveal its seed and flag majority-disagree cases (ADR 0038; `src/jury/close.ts`).
 * Queued by the draw for 14 days later with `panelId`; without one it closes every panel that is due.
 */
import { JURY_JOBS, JuryCloseJob, QUEUES } from "@commonair/contracts/internal";
import { runClose } from "../jury/close.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.jury,
  name: JURY_JOBS.close,
  description: "Close a jury panel and publish its results",
  data: JuryCloseJob,
  attempts: 3,
  backoffMs: 30_000,
  handler: async (data, ctx) => ({ ...(await runClose(ctx, data)) }),
});
