// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, NciiHashJob, QUEUES } from "@commonair/contracts/internal";
import { hashRemovedContent } from "../moderation/ncii-hash.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.nciiHash,
  description: "Hash content removed by an NCII decision into the local block list, then delete its objects",
  data: NciiHashJob,
  attempts: 10,
  backoffMs: 10_000,
  handler: async (data, ctx) => hashRemovedContent(ctx, data),
});
