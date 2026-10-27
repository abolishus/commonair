// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { defineJob } from "../runtime/registry.ts";

/** Stub from the E7 contract step; E7-legal owns this file and implements it. */
export const job = defineJob({
  queue: QUEUES.retention,
  name: "legal-consent-retention",
  description: "Delete old anonymous cookie-consent records in batches",
  data: z.object({}),
  schedule: { pattern: "23 3 * * *" },
  handler: async () => ({ deleted: 0 }),
});
