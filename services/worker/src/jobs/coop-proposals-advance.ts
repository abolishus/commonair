// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { COOP_JOBS } from "@commonair/contracts/internal";
import { coopJob } from "../coop/job.ts";
import { runProposalsAdvance } from "../coop/run.ts";

export const job = coopJob(
  COOP_JOBS.proposalsAdvance,
  "Every 15 s: move proposals through council review and voting, decide them with their tally, apply passed changes",
  { every: 15_000 },
  5 * 60_000,
  runProposalsAdvance,
);
