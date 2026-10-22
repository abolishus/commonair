// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { COOP_JOBS } from "@commonair/contracts/internal";
import { coopJob } from "../coop/job.ts";
import { runCouncilRecompute } from "../coop/run.ts";

export const job = coopJob(
  COOP_JOBS.councilRecompute,
  "Daily: seat a new creator council term when none is current, the UTC month changed or a seat is vacant",
  { pattern: "10 3 * * *", tz: "UTC" },
  10 * 60_000,
  runCouncilRecompute,
);
