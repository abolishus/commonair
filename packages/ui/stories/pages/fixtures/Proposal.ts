// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the Proposal board (#47, a protected decision) in each E5 state. */
import type { Accent } from "@commonair/ui";
import type { TallyTableCheck, TallyTableRow } from "@commonair/ui/blocks/coop";

export type ProposalState = "draft" | "discussion" | "council_review" | "voting" | "rejected" | "applied";

export const breadcrumbs = [
  { label: "Co-op", href: "#coop" },
  { label: "Proposals", href: "#coop/proposals" },
  { label: "#47" },
];

export const proposal = {
  id: "0192d6f1-0000-7000-8000-000000000047",
  title: "Lower the creator share of subscriptions from 71% to 65%",
  author: { id: "0192d6f1-0000-7000-8000-0000000000f1", name: "treasury-wg", accent: "zinc" as Accent },
  opened: "Opened Oct 1",
  body: "Move six points of every subscription to infrastructure for twelve months to fund a second origin region, then revert automatically.\n\nPeak egress is above what one region carries comfortably. Relays now serve about a third of traffic, but the origin is still a single point of failure.",
};

export const statusLabels: Record<ProposalState, string> = {
  draft: "Draft",
  discussion: "Discussion",
  council_review: "Council review",
  voting: "Voting",
  rejected: "Rejected",
  applied: "Applied",
};

export const changes = [
  { key: "platform.cut", from: { streamerShare: 0.71 }, to: { streamerShare: 0.65 }, protected: true },
  {
    key: "discovery.ranking",
    from: { spotlightSlots: 4 },
    to: { spotlightSlots: 5 },
    protected: false,
  },
];

const STEPS = [
  { id: "draft", label: "Draft", at: "2026-09-29T10:00:00.000Z", meta: "Sep 29" },
  { id: "discussion", label: "Discussion", at: "2026-10-01T09:00:00.000Z", meta: "Oct 1 – 8" },
  { id: "council_review", label: "Council review", at: "2026-10-08T09:00:00.000Z", meta: "Oct 8 – 15" },
  { id: "voting", label: "Voting", at: "2026-10-15T09:00:00.000Z", meta: "Oct 15 – 29" },
  { id: "decided", label: "Result", at: "2026-10-29T09:00:00.000Z", meta: "Oct 29" },
] as const;

const ORDER: Record<ProposalState, number> = {
  draft: 0,
  discussion: 1,
  council_review: 2,
  voting: 3,
  rejected: 4,
  applied: 4,
};

/** The proposal's steps with `done` / `current` / `upcoming` and the ISO time each began (empty when unknown). */
export function timelineFor(state: ProposalState): {
  id: string;
  label: string;
  meta: string;
  at: string;
  state: "done" | "current" | "upcoming";
}[] {
  const current = ORDER[state];
  return STEPS.map((step, index) => ({
    id: step.id,
    label: step.id === "decided" && index <= current ? statusLabels[state] : step.label,
    meta: step.meta,
    at: index <= current ? step.at : "",
    state: index < current || (index === current && index === 4) ? "done" : index === current ? "current" : "upcoming",
  }));
}

export const commentSorts = [
  { value: "oldest", label: "Oldest first" },
  { value: "newest", label: "Newest" },
];

export const comments: {
  id: string;
  authorId: string;
  name: string;
  accent: Accent;
  memberClass: string;
  ago: string;
  text: string;
}[] = [
  {
    id: "0192d6f1-0000-7000-8000-0000000000d1",
    authorId: "0192d6f1-0000-7000-8000-0000000000e1",
    name: "Lumen Kitchen",
    accent: "green",
    memberClass: "Streamer",
    ago: "2 days ago",
    text: "Six points is most of my grocery money from this. I would support a tiered version where bigger channels give more.",
  },
  {
    id: "0192d6f1-0000-7000-8000-0000000000d2",
    authorId: "0192d6f1-0000-7000-8000-0000000000e2",
    name: "ohmslaw",
    accent: "blue",
    memberClass: "Viewer",
    ago: "2 days ago",
    text: "The outage in August cost everyone. A second region is worth it, and the automatic revert is a good safeguard.",
  },
  {
    id: "0192d6f1-0000-7000-8000-0000000000d3",
    authorId: "0192d6f1-0000-7000-8000-0000000000f1",
    name: "treasury-wg",
    accent: "zinc",
    memberClass: "Worker",
    ago: "1 day ago",
    text: "Monthly reports of the ring-fenced account will be on the Transparency page, line by line.",
  },
];

export const councilResponse = {
  stance: "oppose",
  stanceLabel: "Opposes",
  body: "Supports the goal, not the mechanism. A temporary cut lands hardest on small channels. Prefer a tiered contribution.",
  publishedAt: "Published Oct 13",
};

export const stances = [
  { value: "support", label: "Support" },
  { value: "oppose", label: "Oppose" },
  { value: "mixed", label: "Mixed" },
  { value: "neutral", label: "Neutral" },
];

export const choices = [
  { value: "yes", label: "Yes", description: "Change the settings as proposed." },
  { value: "no", label: "No", description: "Keep the settings as they are." },
  { value: "abstain", label: "Abstain", description: "Count towards quorum only." },
];

export const participation = { voted: 2_141, eligible: 5_637 };

export const tallyRows: TallyTableRow[] = [
  { scope: "member_wide", label: "All members", yes: 1_402, no: 655, abstain: 84, eligible: 5_637 },
  { scope: "streamer", label: "Streamer class", yes: 160, no: 226, abstain: 16, eligible: 1_108 },
  { scope: "viewer", label: "Viewer class", yes: 1_230, no: 425, abstain: 66, eligible: 4_512 },
  { scope: "worker", label: "Worker class", yes: 12, no: 4, abstain: 2, eligible: 17 },
];

export const tallyChecks: TallyTableCheck[] = [
  {
    rule: "member_wide_quorum",
    label: "Member-wide quorum",
    detail: "turnout 2141/5637 (37.98%), at least 25.00% required",
    passed: true,
  },
  {
    rule: "member_wide_threshold",
    label: "Two thirds of members",
    detail: "yes 1402/2057 of yes+no (68.16%), at least 66.67% required",
    passed: true,
  },
  {
    rule: "streamer_class_quorum",
    label: "Streamer-class quorum",
    detail: "streamer turnout 402/1108 (36.28%), at least 33.00% required",
    passed: true,
  },
  {
    rule: "streamer_class_majority",
    label: "Streamer-class majority",
    detail: "streamer yes 160/386 of yes+no (41.45%), more than 50.00% required",
    passed: false,
  },
];

export const tallyReason = "streamer-class majority not met";
export const tallyReasonText = "Rejected: the streamer class did not pass it (41% yes, more than 50% needed).";

export const passedRows: TallyTableRow[] = [
  { scope: "member_wide", label: "All members", yes: 3, no: 0, abstain: 1, eligible: 4 },
  { scope: "streamer", label: "Streamer class", yes: 2, no: 0, abstain: 0, eligible: 2 },
  { scope: "viewer", label: "Viewer class", yes: 1, no: 0, abstain: 0, eligible: 1 },
  { scope: "worker", label: "Worker class", yes: 0, no: 0, abstain: 1, eligible: 1 },
];

export const passedChecks: TallyTableCheck[] = [
  {
    rule: "member_wide_quorum",
    label: "Member-wide quorum",
    detail: "turnout 4/4 (100.00%), at least 1.00% required",
    passed: true,
  },
  {
    rule: "member_wide_threshold",
    label: "Majority of members",
    detail: "yes 3/3 of yes+no (100.00%), at least 50.00% required",
    passed: true,
  },
];
