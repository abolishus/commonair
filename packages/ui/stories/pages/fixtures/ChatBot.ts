// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the ChatBot board (commands, chat modes, rewards, emotes). */
import type { EmoteTileData } from "@commonair/ui/blocks/media";

export const tabs = [
  { id: "commands", label: "Commands", href: "#chat/commands", current: true },
  { id: "timers", label: "Timers", href: "#chat/timers" },
  { id: "points", label: "Channel points", href: "#chat/points" },
  { id: "filters", label: "Filters", href: "#chat/filters" },
  { id: "emotes", label: "Emotes", href: "#chat/emotes" },
  { id: "settings", label: "Chat settings", href: "#chat/settings" },
];

export interface Command {
  id: string;
  command: string;
  response: string;
  who: string;
  cooldown: string;
  uses: string;
  enabled: boolean;
}

export const commands: Command[] = [
  { id: "schedule", command: "!schedule", response: "Tue/Thu 19:00 UTC — full schedule on the channel page", who: "Everyone", cooldown: "30 s", uses: "412", enabled: true },
  { id: "kiln", command: "!kiln", response: "Cone 6 electric, controller is a Bartlett Genesis", who: "Everyone", cooldown: "30 s", uses: "188", enabled: true },
  { id: "uptime", command: "!uptime", response: "Live for ${uptime}", who: "Everyone", cooldown: "10 s", uses: "902", enabled: true },
  { id: "points", command: "!points", response: "${user}, you have ${points} glaze points", who: "Everyone", cooldown: "5 s", uses: "1,610", enabled: true },
  { id: "so", command: "!so", response: "Go follow ${1} — they were last live in ${1.category}", who: "Mods", cooldown: "0 s", uses: "57", enabled: true },
  { id: "discord", command: "!discord", response: "Community server link (members only)", who: "Subscribers", cooldown: "60 s", uses: "33", enabled: false },
];

export const variables = ["${user}", "${uptime}", "${followage}", "${points}", "${count}"];

export const modes: { id: string; label: string; checked: boolean; select?: { label: string; value: string; options: { value: string; label: string }[] } }[] = [
  { id: "slow", label: "Slow mode", checked: true, select: { label: "Slow mode delay", value: "3", options: [{ value: "3", label: "3 s" }, { value: "10", label: "10 s" }, { value: "30", label: "30 s" }] } },
  { id: "followers", label: "Followers only", checked: false, select: { label: "Follow age", value: "10", options: [{ value: "10", label: "10 min" }, { value: "60", label: "1 hour" }] } },
  { id: "subs", label: "Subscribers only", checked: false },
  { id: "emote", label: "Emote only", checked: false },
  { id: "links", label: "Block links from new chatters", checked: true },
  { id: "email", label: "Verified email to chat", checked: true },
];

export const rewards = [
  { id: "glaze", cost: "500", title: "Pick the next glaze", note: "needs approval", off: false },
  { id: "name", cost: "1,000", title: "Name a pot", off: false },
  { id: "song", cost: "5,000", title: "Song request (stub)", off: true },
];

export const emotes: EmoteTileData[] = [
  { id: "hype", label: "miraHype", glyph: "H", accent: "violet" },
  { id: "kiln", label: "miraKiln", glyph: "K", accent: "orange" },
  { id: "crack", label: "miraCrack", glyph: "C", accent: "red" },
  { id: "glaze", label: "miraGlaze", glyph: "G", accent: "teal" },
  { id: "wave", label: "miraWave", glyph: "W", accent: "sky" },
  { id: "pot", label: "miraPot", glyph: "P", accent: "amber" },
];
