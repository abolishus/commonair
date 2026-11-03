// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Clear Twitch import data 30 days after the import finished (decision (j)). B8-server fills it. */
import { B8_JOBS, ImportRecordExpiryJob, QUEUES } from "@commonair/contracts/internal";
import { b8Stub } from "../b8/stub.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: B8_JOBS.importRecordExpiry,
  description: "Clear Twitch import data past its retention",
  data: ImportRecordExpiryJob,
  schedule: { pattern: "19 4 * * *" },
  handler: b8Stub(B8_JOBS.importRecordExpiry),
});
