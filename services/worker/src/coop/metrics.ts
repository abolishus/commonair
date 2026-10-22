// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { meter } from "@commonair/observability";

const m = meter("commonair.worker");

/** Co-op job instruments (no-ops until telemetry is initialised). */
export const coopMetrics = {
  runs: m.createCounter("worker.coop.runs", {
    description: "Co-op job runs by job and outcome (ran; skipped: another run held the lock)",
  }),
  proposalSteps: m.createCounter("worker.coop.proposal_steps", {
    description:
      "Proposal lifecycle steps by step (council_review, voting, passed, rejected, applied, apply_refused, failed)",
  }),
  tallyDisagreements: m.createCounter("worker.coop.tally_disagreements", {
    description: "Decisions the database refused because its tally differed from the TypeScript tally (a bug)",
  }),
  memberships: m.createCounter("worker.coop.memberships", {
    description: "Membership changes made by membership-sync, by change (activated, lapsed, lapse_refused)",
  }),
};
