// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Channel board (rivertide, live). Mobile and Support reuse the channel and chat. */
import type { ChatBadgeKind } from "@commonair/ui/blocks/media";

export const channel = {
  name: "rivertide",
  accent: "teal" as const,
  title: "Rebuilding a 1970s tape deck — belts, pinch roller, azimuth",
  shortTitle: "Rebuilding a 1970s tape deck",
  category: "Science & Technology",
  tags: ["English", "Repair", "Electronics"],
  viewers: 2418,
  followers: "18.4K followers",
  quality: "1080p60 · source",
  time: "3:41:09 · 1.8 s behind",
};

export const tabs = [
  { id: "about", label: "About", href: "#channel/rivertide/about", current: true },
  { id: "schedule", label: "Schedule", href: "#channel/rivertide/schedule" },
  { id: "videos", label: "Videos", href: "#channel/rivertide/videos" },
  { id: "clips", label: "Clips", href: "#channel/rivertide/clips" },
];

export const panels = {
  about: {
    title: "About rivertide",
    text: "Electronics repair, restoration and the occasional scrap-bin build. Live most weekdays from 18:00 UTC.",
  },
  goal: { title: "Sub goal", label: "New oscilloscope", current: 412, target: 500 },
  gear: { title: "Gear", text: "Hakko FX-888D · Rigol DS1054Z · a very old multimeter" },
};

export const pinned = {
  author: "rivertide",
  colorIndex: 6,
  body: "Parts list for the deck is in the About panel. Be kind to new folks!",
};

export const poll = {
  question: "Next restoration project?",
  timeLeft: "Poll · 1:12 left",
  totalVotes: "384 votes",
  options: [
    { id: "reel", label: "Reel-to-reel", value: 223, percent: 58 },
    { id: "radio", label: "Tube radio", value: 119, percent: 31 },
    { id: "gameboy", label: "Game Boy", value: 42, percent: 11 },
  ],
};

const badgeLabels: Record<ChatBadgeKind, string> = {
  broadcaster: "Broadcaster",
  moderator: "Moderator",
  subscriber: "Subscriber",
  member: "Co-op member",
  vip: "VIP",
};
const badges = (...kinds: ChatBadgeKind[]): { kind: ChatBadgeKind; label: string }[] =>
  kinds.map((kind) => ({ kind, label: badgeLabels[kind] }));

export interface ChatLine {
  id: string;
  author: string;
  colorIndex: number;
  body: string;
  badges?: { kind: ChatBadgeKind; label: string }[];
  notice?: boolean;
  highlight?: boolean;
  timestamp?: string;
}

export const messages: ChatLine[] = [
  { id: "m1", author: "ohmslaw", colorIndex: 8, body: "that pinch roller is GLAZED", badges: badges("subscriber") },
  { id: "m2", author: "kettlebell_kai", colorIndex: 3, body: "isopropyl and a scotch pad, gently" },
  { id: "m3", author: "rivertide", colorIndex: 6, body: "yeah going to try rubber rejuvenator first", badges: badges("broadcaster") },
  { id: "m4", author: "Fernsby", colorIndex: 11, body: "first time here, this is so calming", badges: badges("member") },
  { id: "m5", author: "", colorIndex: 1, body: "Fernsby followed the channel", notice: true },
  { id: "m6", author: "nightcap", colorIndex: 10, body: "azimuth screw is the one on the left of the head right?" },
  { id: "m7", author: "voltagecontrol", colorIndex: 4, body: "left one yes, mark it before you touch it", badges: badges("moderator", "subscriber") },
  { id: "m8", author: "paperlantern", colorIndex: 11, body: "gifted 5 subs to the community!", badges: badges("subscriber"), highlight: true },
  { id: "m9", author: "ohmslaw", colorIndex: 8, body: "W", badges: badges("subscriber") },
  { id: "m10", author: "quietfox", colorIndex: 2, body: "what solder are you using?" },
  { id: "m11", author: "rivertide", colorIndex: 6, body: "SAC305 for this, leaded for the old boards", badges: badges("broadcaster") },
  { id: "m12", author: "tapehead99", colorIndex: 9, body: "my dad had this exact deck" },
  { id: "m13", author: "kettlebell_kai", colorIndex: 3, body: "the VU meters on that thing are gorgeous" },
  { id: "m14", author: "Fernsby", colorIndex: 11, body: "is there a VOD of the earlier part?", badges: badges("member") },
];

/** The shorter chat on the phone board. */
export const phoneMessages: ChatLine[] = [
  { id: "p1", author: "ohmslaw", colorIndex: 8, body: "that pinch roller is GLAZED", badges: badges("subscriber") },
  { id: "p2", author: "kettlebell_kai", colorIndex: 3, body: "isopropyl and a scotch pad, gently" },
  { id: "p3", author: "rivertide", colorIndex: 6, body: "trying rubber rejuvenator first", badges: badges("broadcaster") },
  { id: "p4", author: "paperlantern", colorIndex: 11, body: "gifted 5 subs to the community!", highlight: true },
  { id: "p5", author: "Fernsby", colorIndex: 11, body: "first time here, this is so calming", badges: badges("member") },
  { id: "p6", author: "voltagecontrol", colorIndex: 4, body: "mark the azimuth screw before you touch it", badges: badges("moderator") },
  { id: "p7", author: "tapehead99", colorIndex: 9, body: "my dad had this exact deck" },
];

export const chat = { points: "1,240", slowMode: "Slow mode 3s" };
