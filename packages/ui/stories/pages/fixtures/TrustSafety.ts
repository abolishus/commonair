// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the TrustSafety board (report queue and one open report). */
import type { Accent, StatusTone } from "@commonair/ui";

export const filters = [
  { value: "severity", label: "Highest severity" },
  { value: "oldest", label: "Oldest first" },
];

export const reports: {
  id: string;
  severity: string;
  tone: StatusTone;
  category: string;
  target: string;
  age: string;
  count: string;
  selected: boolean;
}[] = [
  {
    id: "r1",
    severity: "High",
    tone: "danger",
    category: "Harassment in chat",
    target: "loudguy in rivertide",
    age: "14 m",
    count: "4",
    selected: true,
  },
  {
    id: "r2",
    severity: "High",
    tone: "danger",
    category: "Self-harm risk",
    target: "stream · just chatting",
    age: "22 m",
    count: "2",
    selected: false,
  },
  {
    id: "r3",
    severity: "Med",
    tone: "warning",
    category: "Unlabelled mature content",
    target: "stream · art",
    age: "41 m",
    count: "6",
    selected: false,
  },
  {
    id: "r4",
    severity: "Med",
    tone: "warning",
    category: "Spam / scam links",
    target: "14 accounts, same pattern",
    age: "1 h",
    count: "31",
    selected: false,
  },
  {
    id: "r5",
    severity: "Low",
    tone: "neutral",
    category: "Impersonation",
    target: "channel “rivert1de”",
    age: "3 h",
    count: "1",
    selected: false,
  },
  {
    id: "r6",
    severity: "Low",
    tone: "neutral",
    category: "Misleading title",
    target: "stream · hollow depths",
    age: "5 h",
    count: "1",
    selected: false,
  },
];

export const detail = {
  title: "Harassment in chat · channel rivertide",
  opened: "Opened 14 min ago · SLA 1 h",
  account: {
    name: "loudguy",
    accent: "red" as Accent,
    meta: "Joined Jan 2025 · 2 prior warnings",
    badges: ["3 channel bans", "0 platform actions"],
  },
  reporters: "3 viewers + channel moderator voltagecontrol. Reporter identities are hidden from the reported user.",
  evidence: [
    {
      id: "e1",
      time: "19:01:10",
      author: "kettlebell_kai",
      colorIndex: 3,
      body: "the VU meters on that thing are gorgeous",
    },
    {
      id: "e2",
      time: "19:01:22",
      author: "loudguy",
      colorIndex: 1,
      body: "[targeted insult toward a chatter, 1 message]",
    },
    { id: "e3", time: "19:01:40", author: "loudguy", colorIndex: 1, body: "[repeat, after timeout warning]" },
    {
      id: "e4",
      time: "19:01:44",
      author: "",
      colorIndex: 1,
      body: "voltagecontrol timed out loudguy · 10 min",
      notice: true,
    },
  ],
  policy: "Policy: Community guidelines §2.1",
  appeal: "User can appeal for 30 days",
};

export const decisions = [
  { value: "none", label: "No violation" },
  { value: "warning", label: "Warning" },
  { value: "chat", label: "Chat suspension" },
  { value: "account", label: "Account suspension" },
  { value: "ban", label: "Permanent ban" },
];

export const durations = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

export const templates = [
  { value: "harassment-1", label: "Harassment — first suspension" },
  { value: "harassment-2", label: "Harassment — repeat" },
];
