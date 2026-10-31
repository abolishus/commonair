// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-coop: memberships, governance, proposals and votes, elections, council and patronage. Brief: `.claude/briefs/seed-full/seed-coop.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "memberships",
  "membership_shares",
  "membership_history",
  "governance_applications",
  "governance_settings_history",
  "proposals",
  "proposal_comments",
  "proposal_electorate",
  "votes",
  "vote_history",
  "tallies",
  "council_terms",
  "council_members",
  "council_responses",
  "elections",
  "election_candidates",
  "election_ballots",
  "board_seats",
  "patronage_periods",
  "patronage_inputs",
  "patronage_allocations",
] as const;

export const unit: SeedUnit = {
  name: "coop",
  after: ["social", "money"],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-coop: not implemented yet"] };
  },
};
