// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { updateLiveCounters } from "../counters.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.integrity,
  name: "live-counters",
  description: "Verified viewer counts per live channel, peak and viewer-seconds on the broadcast",
  data: z.object({}),
  schedule: { every: 10_000 },
  // A missed tick is covered by the next one (elapsed time is measured between ticks).
  attempts: 1,
  handler: async (_data, ctx) => ({ channels: (await updateLiveCounters(ctx)).length }),
});
