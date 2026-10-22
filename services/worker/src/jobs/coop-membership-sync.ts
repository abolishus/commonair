// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { COOP_JOBS } from "@commonair/contracts/internal";
import { coopJob } from "../coop/job.ts";
import { runMembershipSync } from "../coop/run.ts";

export const job = coopJob(
  COOP_JOBS.membershipSync,
  "Hourly: activate streamer and viewer members who qualify, lapse those who no longer do (voluntary exits respected)",
  { pattern: "5 * * * *", tz: "UTC" },
  30 * 60_000,
  runMembershipSync,
);
