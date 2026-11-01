// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Close a jury panel and publish its results. Owned by W3-jury; a no-op stub until it lands (batch 7 contract step §5.1). */
import { JURY_JOBS, JuryCloseJob, QUEUES } from "@commonair/contracts/internal";
import { stubHandler } from "../b7/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.jury,
  name: JURY_JOBS.close,
  description: "Close a jury panel and publish its results",
  data: JuryCloseJob,
  handler: stubHandler(JURY_JOBS.close),
});
