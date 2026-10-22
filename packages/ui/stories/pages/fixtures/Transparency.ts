// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Transparency board (Q3 2026). Money is integer cents, USD. */
import type { BreakdownSegment } from "@commonair/ui/blocks/data";

export const periods = [
  { value: "2026-q3", label: "Q3 2026" },
  { value: "2026-q2", label: "Q2 2026" },
];

export const intro =
  "Where the money goes, how counts are verified, and what the co-op returns to members. Public, no sign-in needed.";

export const stats = [
  { label: "Gross revenue", cents: 41_288_000, hint: "subs, tips, gifts" },
  { label: "Paid to creators", cents: 28_971_000, hint: "70.2% of gross" },
  { label: "Operating cost", cents: 7_140_000, hint: "infra, staff, legal" },
  { label: "Surplus for patronage", cents: 3_214_000, hint: "allocated yearly" },
];

export const flow: BreakdownSegment[] = [
  { id: "creators", label: "Creator payouts", value: 28_971_000, color: "--chart-1" },
  { id: "infra", label: "Infrastructure & bandwidth", value: 3_895_000, color: "--chart-2" },
  { id: "wages", label: "Worker-member wages", value: 2_610_000, color: "--chart-3" },
  { id: "safety", label: "Trust & safety, legal", value: 635_000, color: "--chart-4" },
  { id: "patronage", label: "Patronage reserve", value: 3_214_000, color: "--chart-5" },
  { id: "processing", label: "Payment processing", value: 1_963_000, color: "--chart-6" },
];

export const formula = `share = 0.6 × streamer_revenue_share
      + 0.3 × verified_watch_hours_share
      + 0.1 × participation_share
cap per member = 2% of pool`;

export const formulaNotes = [
  "Watch hours count only verified sessions.",
  "Participation: votes cast and moderation hours.",
  "The cap keeps the largest channels from taking the pool.",
];

export const statement = [
  { id: "revenue", line: "Revenue share", basis: "0.31% × 0.6", cents: 5980 },
  { id: "watch", line: "Watch-hours share", basis: "0.28% × 0.3", cents: 2700 },
  { id: "participation", line: "Participation", basis: "0.30% × 0.1", cents: 960 },
  { id: "total", line: "Estimated allocation", basis: "", cents: 9640 },
];

export const metrics = [
  {
    id: "integrity",
    title: "Viewer integrity",
    value: "4.6%",
    caption: "of sessions excluded",
    body: "Datacenter ranges, headless browsers, concurrency abuse. 212 appeals, 31 upheld.",
  },
  {
    id: "relays",
    title: "Community relays",
    value: "38%",
    caption: "of video egress",
    body: "142 volunteer relays. Signed receipts are cross-checked against the origin; 2 relays removed for over-reporting.",
  },
  {
    id: "safety",
    title: "Trust & safety",
    value: "1,904",
    caption: "reports handled",
    body: "Median first response 41 min. 12 DMCA notices, 3 counter-notices. 0 government data requests.",
  },
];

/** Proposals decided per month (`TransparencyMonth.governance`). */
export const governance = [
  {
    proposalId: "0192d6f1-0000-7000-8000-000000000045",
    title: "#45 Publish the integrity exclusion counts per channel",
    status: "applied",
    kind: "ordinary",
    passed: true,
    outcomeLabel: "Passed",
    month: "2026-09",
    decidedAt: "Sep 30",
  },
  {
    proposalId: "0192d6f1-0000-7000-8000-000000000044",
    title: "#44 Raise the streamer share of tips to 95%",
    status: "rejected",
    kind: "protected",
    passed: false,
    outcomeLabel: "Rejected",
    reason: "Streamer-class majority not met",
    month: "2026-09",
    decidedAt: "Sep 28",
  },
  {
    proposalId: "0192d6f1-0000-7000-8000-000000000043",
    title: "#43 Rename the moderation queue to review queue",
    status: "withdrawn",
    kind: "ordinary",
    passed: null,
    outcomeLabel: "Withdrawn",
    month: "2026-08",
    decidedAt: "Aug 19",
  },
];

/** Approved patronage allocations posted per month (`TransparencyMonth.patronageDistributed`). */
export const patronageMonths = [
  { month: "2026-09", label: "September 2026", members: 1_180, cents: 2_980_500 },
  { month: "2026-08", label: "August 2026", members: 1_142, cents: 2_711_000 },
  { month: "2026-07", label: "July 2026", members: 1_097, cents: 0 },
];
