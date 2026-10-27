// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DmcaDisableJob, MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { disableNoticeObjects } from "../dmca/disable.ts";
import { defineJob } from "../runtime/registry.ts";

/** E7-dmca: after `safety.dmca.action` → actioned (the API enqueues it once per notice). */
export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.dmcaDisable,
  description: "DMCA: move an actioned notice's removed objects to the private DMCA prefix",
  data: DmcaDisableJob,
  attempts: 10,
  handler: async (data, ctx) => disableNoticeObjects(ctx, data),
});
