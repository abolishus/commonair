// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { enforceVodRetention } from "../housekeeping.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.retention,
  name: "vod-retention",
  description: "Delete expired VODs' objects from storage and mark them deleted",
  data: z.object({}),
  schedule: { pattern: "27 * * * *" },
  handler: async (_data, ctx) => enforceVodRetention(ctx),
});
