// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { closeStalePlaybackSessions } from "../housekeeping.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.integrity,
  name: "close-stale-sessions",
  description: "End playback sessions without a heartbeat for 2 minutes",
  data: z.object({}),
  schedule: { every: 60_000 },
  handler: async (_data, ctx) => closeStalePlaybackSessions(ctx),
});
