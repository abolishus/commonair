// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the Proposals board (`/coop/proposals`). */

export const statusFilters = [
  { value: "all", label: "All" },
  { value: "discussion", label: "Discussion" },
  { value: "council_review", label: "Council review" },
  { value: "voting", label: "Voting" },
  { value: "passed", label: "Passed" },
  { value: "rejected", label: "Rejected" },
  { value: "applied", label: "Applied" },
  { value: "withdrawn", label: "Withdrawn" },
];

export const statusLabels: Record<string, string> = Object.fromEntries(
  statusFilters.map((filter) => [filter.value, filter.label]),
);

export interface ProposalListEntry {
  id: string;
  number: number;
  title: string;
  summary: string;
  status: string;
  kind: "ordinary" | "protected";
  meta: string;
  participation: { voted: number; eligible: number } | null;
}

export const proposals: ProposalListEntry[] = [
  {
    id: "0192d6f1-0000-7000-8000-000000000047",
    number: 47,
    title: "Lower the creator share of subscriptions from 71% to 65%",
    summary: "Fund a second origin region by moving 6 points of every subscription to infrastructure for 12 months.",
    status: "voting",
    kind: "protected",
    meta: "Voting closes Oct 24 · 214 comments",
    participation: { voted: 2141, eligible: 5637 },
  },
  {
    id: "0192d6f1-0000-7000-8000-000000000049",
    number: 49,
    title: "Adopt a clearer mature-content labelling policy",
    summary: "Replaces the single mature flag with three labels and an 18+ gate for the strongest.",
    status: "council_review",
    kind: "ordinary",
    meta: "Council review ends Oct 25 · 41 comments",
    participation: null,
  },
  {
    id: "0192d6f1-0000-7000-8000-000000000050",
    number: 50,
    title: "Show five spotlight slots on the home page",
    summary: "One more slot for small channels in the home page spotlight.",
    status: "discussion",
    kind: "ordinary",
    meta: "Discussion ends Oct 28 · 9 comments",
    participation: null,
  },
  {
    id: "0192d6f1-0000-7000-8000-000000000045",
    number: 45,
    title: "Publish the integrity exclusion counts per channel",
    summary: "Every channel sees how many of its sessions were excluded and why.",
    status: "applied",
    kind: "ordinary",
    meta: "Applied Oct 2",
    participation: { voted: 1980, eligible: 5410 },
  },
  {
    id: "0192d6f1-0000-7000-8000-000000000044",
    number: 44,
    title: "Raise the streamer share of tips to 95%",
    summary: "Tips are personal; the co-op keeps 5% for processing and the reserve.",
    status: "rejected",
    kind: "protected",
    meta: "Rejected Sep 28 · streamer-class majority not met",
    participation: { voted: 2310, eligible: 5390 },
  },
];
