// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { expireAuthRows } from "../housekeeping.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.retention,
  name: "expire-auth-rows",
  description: "Delete expired verification tokens and auth sessions",
  data: z.object({}),
  schedule: { pattern: "7 * * * *" },
  handler: async (_data, ctx) => expireAuthRows(ctx),
});
