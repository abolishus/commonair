// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, ModerationT0MediaJob, QUEUES } from "@commonair/contracts/internal";
import { preserveT0Media } from "../moderation/t0-media.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.moderation,
  name: MODERATION_JOBS.t0Media,
  description: "Seal a T0 subject's VOD, clip and thumbnail objects into the evidence bucket, then delete the public copies",
  data: ModerationT0MediaJob,
  attempts: 15,
  backoffMs: 5_000,
  handler: async (data, ctx, meta) => preserveT0Media(ctx, data, meta),
});
