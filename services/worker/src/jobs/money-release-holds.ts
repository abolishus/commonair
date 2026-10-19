// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { releaseHolds } from "../money/holds.ts";
import { MONEY_JOBS, moneyJob } from "../money/job.ts";

export const job = moneyJob(
  MONEY_JOBS.releaseHolds,
  "Move creator shares past the payout.rules hold from creator-hold to available",
  { pattern: "41 * * * *" },
  20 * 60_000,
  async (ctx) => ({ ...(await releaseHolds(ctx)) }),
);
