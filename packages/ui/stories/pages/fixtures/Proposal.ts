// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Proposal board (#47, protected decision, voting open). */
import type { Accent } from "@commonair/ui";
import type { BreakdownSegment, TimelineStep } from "@commonair/ui/blocks/data";

export const breadcrumbs = [
  { label: "Co-op", href: "#coop" },
  { label: "Proposals", href: "#coop/proposals" },
  { label: "#47" },
];

export const proposal = {
  title: "Lower the creator share of subscriptions from 71% to 65%",
  key: "revenue.creator_share",
  proposer: "Proposed by the treasury working group",
  opened: "Opened Oct 11",
  closes: "Closes Oct 21, 18:00 UTC",
  summary:
    "Move six points of every subscription to infrastructure for twelve months to fund a second origin region, then revert automatically.",
  why: "Peak egress is above what one region carries comfortably. Relays now serve about a third of traffic, but the origin is still a single point of failure.",
  changes: [
    "Creator share: 71% → 65% from Nov 1, 2026 to Oct 31, 2027.",
    "The six points go to a ring-fenced infrastructure account, reported monthly.",
    "Tips are unaffected.",
  ],
};

export const review = {
  title: "Creator council review · advised against, 3–2",
  quote:
    "“Supports the goal, not the mechanism. A temporary cut lands hardest on small channels. Prefer a tiered contribution.”",
};

export const commentSorts = [
  { value: "helpful", label: "Most helpful" },
  { value: "newest", label: "Newest" },
];

export const comments: {
  name: string;
  accent: Accent;
  memberClass: string;
  ago: string;
  helpful: number;
  text: string;
}[] = [
  {
    name: "Lumen Kitchen",
    accent: "green",
    memberClass: "Streamer",
    ago: "2 days ago",
    helpful: 96,
    text: "Six points is most of my grocery money from this. I would support a tiered version where bigger channels give more.",
  },
  {
    name: "ohmslaw",
    accent: "blue",
    memberClass: "Viewer",
    ago: "2 days ago",
    helpful: 61,
    text: "The outage in August cost everyone. A second region is worth it, and the automatic revert is a good safeguard.",
  },
  {
    name: "treasury-wg",
    accent: "zinc",
    memberClass: "Worker",
    ago: "1 day ago",
    helpful: 44,
    text: "Monthly reports of the ring-fenced account will be on the Transparency page, line by line.",
  },
];

export const choices = [
  { value: "yes", title: "Yes" },
  { value: "no", title: "No" },
  { value: "abstain", title: "Abstain" },
];
export const voteNote = "Voting as streamer member";

const tally = (yes: number, no: number, abstain: number): BreakdownSegment[] => [
  { id: "yes", label: "Yes", value: yes, color: "--chart-2" },
  { id: "no", label: "No", value: no, color: "--chart-5" },
  { id: "abstain", label: "Abstain", value: abstain, color: "--chart-7" },
];

export const tallies = [
  {
    label: "All members",
    note: "quorum 25% · met",
    status: "Passing",
    passed: true,
    segments: tally(58, 37, 5),
    votes: 2141,
  },
  {
    label: "Streamer class",
    note: "quorum 33% · met",
    status: "Failing",
    passed: false,
    segments: tally(41, 55, 4),
    votes: 402,
  },
];
export const tallyNote = "If either row fails, the database rejects the change, whoever is asking.";

export const timeline: TimelineStep[] = [
  { id: "discussion", label: "Discussion", meta: "Oct 1–10", state: "done" },
  { id: "review", label: "Council review", meta: "Oct 10", state: "done" },
  { id: "voting", label: "Voting", meta: "Oct 11–21", state: "current" },
  { id: "result", label: "Result & enactment", meta: "Oct 21", state: "upcoming" },
];
