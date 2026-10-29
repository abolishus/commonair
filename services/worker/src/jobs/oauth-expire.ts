// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Owned by E9-oauth; the contract step registered it with its final schedule and a no-op handler. */
import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.retention,
  name: "oauth-expire",
  description: "Delete expired authorization and device codes and long-dead OAuth tokens (ADR 0027)",
  data: z.object({}),
  schedule: { pattern: "17 * * * *" },
  handler: async () => ({ codes: 0, deviceCodes: 0, tokens: 0 }),
});
