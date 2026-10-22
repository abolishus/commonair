// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { COOP_JOBS } from "@commonair/contracts/internal";
import { coopJob } from "../coop/job.ts";
import { runElectionsAdvance } from "../coop/run.ts";

export const job = coopJob(
  COOP_JOBS.electionsAdvance,
  "Every minute: open board-election voting when nominations close, close elections whose voting ended",
  { every: 60_000 },
  5 * 60_000,
  runElectionsAdvance,
);
