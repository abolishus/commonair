// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Clear Twitch import data 30 days after the import finished (decision (j), `portability/record-expiry.ts`). */
import { B8_JOBS, ImportRecordExpiryJob, QUEUES } from "@commonair/contracts/internal";
import { expireImportRecords } from "../portability/record-expiry.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: B8_JOBS.importRecordExpiry,
  description: "Clear Twitch import data past its retention",
  data: ImportRecordExpiryJob,
  schedule: { pattern: "19 4 * * *" },
  handler: async (_data, ctx) => ({ ...(await expireImportRecords(ctx)) }),
});
