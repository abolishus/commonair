// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Coop board (co-op overview & governance). Money is integer cents, USD. */
import type { Accent, StatusTone } from "@commonair/ui";
import type { BreakdownSegment } from "@commonair/ui/blocks/data";
import type { Money } from "../money.tsx";

export const tabs = [
  { id: "overview", label: "Overview", href: "#coop", current: true },
  { id: "proposals", label: "Proposals", href: "#coop/proposals" },
  { id: "council", label: "Council", href: "#coop/council" },
  { id: "transparency", label: "Transparency", href: "#transparency" },
];

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

export const council: { name: string; accent: Accent; seat: string }[] = [
  { name: "rivertide", accent: "teal", seat: "Chair" },
  { name: "Okonkwo Plays", accent: "amber", seat: "Seat 2" },
  { name: "synthesist_ana", accent: "pink", seat: "Seat 3" },
  { name: "Lumen Kitchen", accent: "green", seat: "Seat 4 · small-channel seat" },
  { name: "Tinwhistle", accent: "sky", seat: "Seat 5 · small-channel seat" },
];

export const events = [
  { id: "e1", month: "Nov", day: "4", title: "Council open session (streamed)" },
  { id: "e2", month: "Dec", day: "2", title: "Annual general meeting" },
];
