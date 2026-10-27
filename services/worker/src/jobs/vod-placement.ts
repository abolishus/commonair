// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { defineJob } from "../runtime/registry.ts";

/**
 * Move a VOD's objects to where `vodPlacement` of its database state says they belong (ADR 0009
 * amendment 1, decision 3). With `vodId`: that VOD (enqueued by `vods.update` and `vods.remove`
 * after commit). Without: the one-minute sweep over VODs whose `storage_prefix` disagrees with
 * their state (also run on demand, empty data, by the ops test hook).
 *
 * Stub until W0-media-exposure lands it.
 */
export const job = defineJob({
  queue: QUEUES.retention,
  name: "vod-placement",
  description: "Move VOD objects between the public vods/ and private recordings/ prefixes to match their state",
  data: z.object({ vodId: z.uuid().optional() }),
  schedule: { every: 60_000 },
  handler: async () => ({ notBuilt: 1 }),
});
