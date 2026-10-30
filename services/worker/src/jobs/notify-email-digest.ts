// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmailDigestJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { defineJob } from "../runtime/registry.ts";

/** ADR 0028 decision 3: sweep `notification_email_queue` and send each member's due go-live digest. */
export const job = defineJob({
  queue: QUEUES.email,
  name: NOTIFY_JOBS.emailDigest,
  description: "Send due go-live email digests",
  data: EmailDigestJob,
  schedule: { every: NOTIFY_RULES.emailDigestSweepMs },
  attempts: 1,
  // Stub: N1-email implements it.
  handler: async () => ({ users: 0, sent: 0 }),
});
