// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmailDigestJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { sweepEmailDigests } from "../notify/email/digest.ts";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0028 decision 3: sweep `notification_email_queue` and send each member's due go-live digest. */
export const job = defineJob({
  queue: QUEUES.email,
  name: NOTIFY_JOBS.emailDigest,
  description: "Send due go-live email digests",
  data: EmailDigestJob,
  schedule: { every: NOTIFY_RULES.emailDigestSweepMs },
  // A failed sweep is not retried: the next one runs within 30 s and picks up the same rows.
  attempts: 1,
  handler: async (_data, ctx) => sweepEmailDigests(ctx),
});
