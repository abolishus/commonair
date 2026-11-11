// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { GovernanceEmailJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { sendGovernanceEmailPage } from "../notify/governance-email/send.ts";
import { defineJob } from "../runtime/registry.ts";

/**
 * Overhaul wave 5: one page of governance email (vote opened, result published) per
 * `coop.proposal.update` event, enqueued by the outbox relay (`notify/outbox-jobs.ts`). Retried:
 * the per-member claims skip everyone a failed attempt already mailed.
 */
export const job = defineJob({
  queue: QUEUES.notifications,
  name: NOTIFY_JOBS.governanceEmail,
  description: "Email one page of members about a co-op vote opening or its result",
  data: GovernanceEmailJob,
  attempts: 5,
  handler: (data, ctx) => sendGovernanceEmailPage(ctx, data),
});
