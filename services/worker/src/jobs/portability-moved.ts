// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `PORTABILITY_JOBS.moved` (ADR 0037 decision 3): on `channel.moved`, one `channelMoved` email per
 * grant holder, then the grants go (`portability/moved.ts`). A send that failed leaves its grant,
 * and the job throws so BullMQ retries just those.
 */
import { PORTABILITY_JOBS, PortabilityMovedJob, QUEUES } from "@commonair/contracts/internal";
import { sendMovedNotices } from "../portability/moved.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.portability,
  name: PORTABILITY_JOBS.moved,
  description: "On channel.moved: email each grant holder once, then drop the grants",
  data: PortabilityMovedJob,
  attempts: 5,
  backoffMs: 60_000,
  handler: async ({ channelId }, ctx) => {
    const out = await sendMovedNotices(ctx, channelId);
    if (out.failed > 0) throw new Error(`${out.failed} moved notices failed; retrying`);
    return { sent: out.sent, dropped: out.dropped };
  },
});
