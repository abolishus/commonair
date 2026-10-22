// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data for the Council board (`/coop/council`). */
import type { Accent } from "@commonair/ui";

export const term = {
  id: "0192d6f2-0000-7000-8000-000000000010",
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-11-01T00:00:00.000Z",
  label: "October 2026 term · Oct 1 – Oct 31",
};

export const councilMembers: { userId: string; name: string; accent: Accent; rank: number; score: number }[] = [
  { userId: "0192d6f2-0000-7000-8000-0000000000a1", name: "rivertide", accent: "teal", rank: 1, score: 412.5 },
  { userId: "0192d6f2-0000-7000-8000-0000000000a2", name: "Okonkwo Plays", accent: "amber", rank: 2, score: 388 },
  { userId: "0192d6f2-0000-7000-8000-0000000000a3", name: "synthesist_ana", accent: "pink", rank: 3, score: 301.25 },
  { userId: "0192d6f2-0000-7000-8000-0000000000a4", name: "Lumen Kitchen", accent: "green", rank: 4, score: 140 },
  { userId: "0192d6f2-0000-7000-8000-0000000000a5", name: "Tinwhistle", accent: "sky", rank: 5, score: 96.5 },
];

export const method = [
  { term: "Method", value: "council-2026.1" },
  { term: "Seats", value: "5 (2 for small channels)" },
  { term: "Window", value: "last 90 days" },
  { term: "Weights", value: "hours 0.5 · verified viewer-hours 0.3 · tenure 0.2" },
  { term: "Candidates counted", value: "1,108 streamer members" },
];

export const boardSeats: { userId: string; name: string; accent: Accent; memberClass: string; seat: string }[] = [
  {
    userId: "0192d6f2-0000-7000-8000-0000000000b1",
    name: "rivertide",
    accent: "teal",
    memberClass: "streamer",
    seat: "Streamer seat · until Mar 2027",
  },
  {
    userId: "0192d6f2-0000-7000-8000-0000000000b2",
    name: "ohmslaw",
    accent: "blue",
    memberClass: "viewer",
    seat: "Viewer seat · until Mar 2027",
  },
  {
    userId: "0192d6f2-0000-7000-8000-0000000000b3",
    name: "treasury-wg",
    accent: "zinc",
    memberClass: "worker",
    seat: "Worker seat · until Sep 2027",
  },
];

export const elections = [
  {
    id: "0192d6f2-0000-7000-8000-0000000000e1",
    memberClass: "viewer",
    status: "voting",
    statusLabel: "Voting",
    title: "Viewer seat election",
    details: [
      { term: "Seats", value: "1" },
      { term: "Nominations closed", value: "Oct 14" },
      { term: "Voting ends", value: "Oct 28" },
    ],
    candidates: [
      {
        userId: "0192d6f2-0000-7000-8000-0000000000c1",
        name: "ohmslaw",
        accent: "blue" as Accent,
        statement: "Keep the books open.",
        elected: false,
      },
      {
        userId: "0192d6f2-0000-7000-8000-0000000000c2",
        name: "fernpixel",
        accent: "green" as Accent,
        statement: "Better tools for small communities.",
        elected: false,
      },
    ],
  },
  {
    id: "0192d6f2-0000-7000-8000-0000000000e2",
    memberClass: "streamer",
    status: "closed",
    statusLabel: "Closed",
    title: "Streamer seat election",
    details: [
      { term: "Seats", value: "1" },
      { term: "Closed", value: "Mar 30" },
    ],
    candidates: [
      {
        userId: "0192d6f2-0000-7000-8000-0000000000c3",
        name: "rivertide",
        accent: "teal" as Accent,
        statement: "A fair split, published monthly.",
        votes: "1,204 votes",
        elected: true,
      },
      {
        userId: "0192d6f2-0000-7000-8000-0000000000c4",
        name: "synthesist_ana",
        accent: "pink" as Accent,
        statement: "Music licensing that works.",
        votes: "981 votes",
        elected: false,
      },
    ],
  },
];
