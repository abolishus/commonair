// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Community board (moderation queue). */
import type { Accent, StatusTone } from "@commonair/ui";

export const tabs = [
  { id: "queue", label: "Queue", href: "#moderation", current: true, count: 3 },
  { id: "banned", label: "Banned & timed out", href: "#moderation/banned" },
  { id: "mods", label: "Moderators", href: "#moderation/mods" },
  { id: "log", label: "Mod log", href: "#moderation/log" },
  { id: "appeals", label: "Appeals", href: "#moderation/appeals", count: 1 },
];

export const queue: {
  id: string;
  kind: string;
  tone: StatusTone;
  reason: string;
  ago: string;
  who: string;
  colorIndex: number;
  text: string;
  primary: string;
  secondary: string;
}[] = [
  {
    id: "q1",
    kind: "Held by filter",
    tone: "warning",
    reason: "Link from a new account",
    ago: "12 s ago",
    who: "spamcannon_77",
    colorIndex: 2,
    text: "cheap followers at [link]",
    primary: "Allow",
    secondary: "Deny",
  },
  {
    id: "q2",
    kind: "User report",
    tone: "danger",
    reason: "Harassment · reported by 3 viewers",
    ago: "2 min ago",
    who: "loudguy",
    colorIndex: 1,
    text: "[message hidden until reviewed]",
    primary: "Show message",
    secondary: "Dismiss report",
  },
  {
    id: "q3",
    kind: "Held by filter",
    tone: "warning",
    reason: "Blocked term list",
    ago: "4 min ago",
    who: "gremlin_420",
    colorIndex: 7,
    text: "[1 blocked term]",
    primary: "Allow",
    secondary: "Deny",
  },
];

export const user = {
  name: "spamcannon_77",
  accent: "orange" as Accent,
  meta: "Account 2 days old · not following",
  stats: [
    { label: "Messages", value: "14" },
    { label: "Timeouts", value: "1" },
    { label: "Reports", value: "3" },
  ],
  recent: [
    { id: "r1", time: "19:02", text: "cheap followers at [link removed]" },
    { id: "r2", time: "19:01", text: "hey streamer check dm" },
    { id: "r3", time: "18:58", text: "first" },
  ],
};

export const actions: { id: string; who: string; accent: Accent; action: string; ago: string }[] = [
  { id: "a1", who: "voltagecontrol", accent: "lime", action: "timed out loudguy · 10 min", ago: "4 m" },
  { id: "a2", who: "mira", accent: "violet", action: "enabled slow mode · 3 s", ago: "22 m" },
  { id: "a3", who: "voltagecontrol", accent: "lime", action: "deleted a message", ago: "31 m" },
];
