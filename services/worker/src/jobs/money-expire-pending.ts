// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { moneyConfig } from "../money/config.ts";
import { expirePendingPayments } from "../money/expire.ts";
import { MONEY_JOBS, moneyJob } from "../money/job.ts";

export const job = moneyJob(
  MONEY_JOBS.expirePending,
  "Fail pending payments past expires_at and expire what hangs off them",
  { every: 5 * 60_000 },
  5 * 60_000,
  async (ctx) => ({ ...(await expirePendingPayments(ctx, moneyConfig(ctx))) }),
);
