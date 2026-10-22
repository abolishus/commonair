// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Coop board (co-op overview & governance). Money is integer cents, USD. */
import type { Accent, StatusTone } from "@commonair/ui";
import type { BreakdownSegment } from "@commonair/ui/blocks/data";
import type { Money } from "../money.tsx";

export const intro =
  "CommonAir is owned by its members: the people who stream, watch and work here. Members elect the creator council, vote on proposals and share the surplus.";

export const membership = {
  name: "mira",
  accent: "violet" as Accent,
  since: "Streamer member since March 2026 · member #1,204",
  standing: "In good standing",
  stats: [
    { label: "Class", value: "Streamer", hint: "Also counts in all-member votes" },
    { label: "Shares held", value: "1", hint: "One member, one vote" },
    { label: "Votes cast", value: "7 / 8", hint: "this year" },
    { label: "Patronage (est.)", value: { cents: 9_640 }, hint: "2026 allocation" },
  ] as { label: string; value: string | Money; hint: string }[],
};

export const proposals: {
  id: string;
  apiStatus: string;
  number: number;
  title: string;
  protected: boolean;
  status: string;
  tone: StatusTone;
  summary: string;
  ends: string;
  turnout: number | null;
  comments: number;
  voted: boolean;
}[] = [
  {
    id: "0192d6f1-0000-7000-8000-000000000047",
    apiStatus: "voting",
    number: 47,
    title: "Lower the creator share of subscriptions from 71% to 65%",
    protected: true,
    status: "Voting",
    tone: "info",
    summary: "Fund a second origin region by moving 6 points of every subscription to infrastructure for 12 months.",
    ends: "Closes in 3 days",
    turnout: 38,
    comments: 214,
    voted: true,
  },
  {
    id: "0192d6f1-0000-7000-8000-000000000048",
    apiStatus: "voting",
    number: 48,
    title: "Add a small-channel seat to the creator council",
    protected: false,
    status: "Voting",
    tone: "info",
    summary: "Reserve one more council seat for channels averaging under 50 verified viewers.",
    ends: "Closes in 6 days",
    turnout: 21,
    comments: 88,
    voted: false,
  },
  {
    id: "0192d6f1-0000-7000-8000-000000000049",
    apiStatus: "council_review",
    number: 49,
    title: "Adopt a clearer mature-content labelling policy",
    protected: false,
    status: "Council review",
    tone: "warning",
    summary: "Replaces the single mature flag with three labels and an 18+ gate for the strongest.",
    ends: "Voting opens Oct 25",
    turnout: null,
    comments: 41,
    voted: false,
  },
];

export const membersByClass: BreakdownSegment[] = [
  { id: "viewer", label: "Viewer members", value: 4512, color: "--chart-1" },
  { id: "streamer", label: "Streamer members", value: 1108, color: "--chart-2" },
  { id: "worker", label: "Worker members", value: 17, color: "--chart-3" },
];
export const protectedNote =
  "Protected decisions (the revenue split, data policy, these rules) also need a majority of the streamer class.";

export const council: { userId: string; name: string; accent: Accent; rank: number; seat: string }[] = [
  { userId: "0192d6f2-0000-7000-8000-0000000000a1", name: "rivertide", accent: "teal", rank: 1, seat: "Chair" },
  { userId: "0192d6f2-0000-7000-8000-0000000000a2", name: "Okonkwo Plays", accent: "amber", rank: 2, seat: "Seat 2" },
  { userId: "0192d6f2-0000-7000-8000-0000000000a3", name: "synthesist_ana", accent: "pink", rank: 3, seat: "Seat 3" },
  {
    userId: "0192d6f2-0000-7000-8000-0000000000a4",
    name: "Lumen Kitchen",
    accent: "green",
    rank: 4,
    seat: "Seat 4 · small-channel seat",
  },
  {
    userId: "0192d6f2-0000-7000-8000-0000000000a5",
    name: "Tinwhistle",
    accent: "sky",
    rank: 5,
    seat: "Seat 5 · small-channel seat",
  },
];

/** Active classes of the signed-in member (`coop-membership-card` `data-classes`). */
export const memberClasses = ["streamer", "viewer"];

export const decisions = [
  {
    proposalId: "0192d6f1-0000-7000-8000-000000000045",
    title: "#45 Publish the integrity exclusion counts per channel",
    status: "applied",
    kind: "ordinary",
    passed: true,
    outcomeLabel: "Passed",
    month: "2026-10",
    decidedAt: "Oct 2",
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
];

export const events = [
  { id: "e1", month: "Nov", day: "4", title: "Council open session (streamed)" },
  { id: "e2", month: "Dec", day: "2", title: "Annual general meeting" },
];
