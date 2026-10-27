// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { deleteOldAnonymousConsent } from "../legal/consent-retention.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.retention,
  name: "legal-consent-retention",
  description: "Delete anonymous cookie-consent records older than about 13 months, in batches",
  data: z.object({}),
  schedule: { pattern: "23 3 * * *" },
  handler: async (_data, ctx) => deleteOldAnonymousConsent(ctx),
});
