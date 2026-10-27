// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { defineJob } from "../runtime/registry.ts";
import { placeVod, sweepVodPlacement, VOD_PLACEMENT_JOB } from "../vod/placement.ts";

/**
 * Move a VOD's objects to where `vodPlacement` of its database state says they belong (ADR 0009
 * amendment 1, decision 3; `src/vod/placement.ts`). With `vodId`: that VOD (enqueued by
 * `vods.update` and `vods.remove` after commit, and by the sweep). Without: the one-minute sweep
 * over VODs whose `storage_prefix` disagrees with their state (also run on demand, empty data, by
 * the ops test hook).
 */
export const job = defineJob({
  queue: QUEUES.retention,
  name: VOD_PLACEMENT_JOB,
  description: "Move VOD objects between the public vods/ and private recordings/ prefixes to match their state",
  data: z.object({ vodId: z.uuid().optional() }),
  schedule: { every: 60_000 },
  handler: async (data, ctx) => {
    if (!data.vodId) return sweepVodPlacement(ctx);
    const r = await placeVod(ctx, data.vodId);
    return { [r.outcome]: 1, objects: r.objects };
  },
});
