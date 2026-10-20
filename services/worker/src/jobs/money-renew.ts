// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { moneyConfigFromEnv } from "../money/config.ts";
import { MONEY_JOBS, moneyJob } from "../money/job.ts";
import { renewDueSubscriptions } from "../money/renew.ts";

export const job = moneyJob(
  MONEY_JOBS.renew,
  "End or renew subscriptions whose period is over (manual renewals become past_due)",
  { every: 5 * 60_000 },
  5 * 60_000,
  async (ctx) => ({ ...(await renewDueSubscriptions(ctx, moneyConfigFromEnv())) }),
);
