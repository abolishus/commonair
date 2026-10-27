// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { DmcaDisableJob, MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";

/** Stub from the E7 contract step; E7-dmca owns this file and implements it. */
export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.dmcaDisable,
  description: "DMCA: move an actioned notice's removed objects to the private DMCA prefix",
  data: DmcaDisableJob,
  attempts: 10,
  handler: async () => ({ items: 0, objects: 0 }),
});
