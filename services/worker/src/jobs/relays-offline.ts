// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { markRelaysOffline } from "../housekeeping.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.integrity,
  name: "relays-offline",
  description: "Mark relays offline after 3 minutes of missed health checks (audit-logged)",
  data: z.object({}),
  schedule: { every: 60_000 },
  handler: async (_data, ctx) => markRelaysOffline(ctx),
});
