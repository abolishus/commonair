// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the StreamManager board (live dashboard). */
import type { StatusTone } from "@commonair/ui";
import type { Money } from "../money.tsx";

export const stats = [
  { label: "Verified viewers", value: "412", delta: "peak 468" },
  { label: "New followers", value: "+37", hint: "this stream" },
  { label: "Subs & gifts", value: "14", hint: "5 gifted" },
  { label: "Chatters", value: "96", hint: "1,804 messages" },
];

export const health = [
  { term: "Ingest", value: "RTMP · 6,012 kbps" },
  { term: "Video", value: "1080p60 · H.264" },
  { term: "Dropped frames", value: "0.02%" },
  { term: "Viewer latency", value: "2.1 s" },
  { term: "Renditions", value: "1080 · 720 · 480 · 360" },
  { term: "Relays serving", value: "3 · 38% of egress" },
];
export const simulcast = "2 targets";

/** Bitrate samples, last 10 minutes (kbps). */
export const bitrate = Array.from({ length: 40 }, (_, i) => ({ t: `${i}`, kbps: 5400 + ((i * 13) % 20) * 40 }));

export const streamInfo = {
  title: "Glaze tests: copper reds, round 4",
  category: "crafting",
  language: "en",
  tags: ["Ceramics", "Chill", "Educational"],
};
export const categoryOptions = [
  { value: "crafting", label: "Makers & Crafting" },
  { value: "chatting", label: "Just Chatting" },
];
export const languageOptions = [
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];
export const tagSuggestions = ["Ceramics", "Chill", "Educational", "Pottery", "Glazes", "Kiln"];

export const quickActions = ["Poll", "Prediction", "Raid", "Clip", "Slow mode", "Shield mode"] as const;

export const feed: {
  id: string;
  kind: string;
  tone: StatusTone;
  who: string;
  what: string;
  amount?: Money;
  message?: string;
  ago: string;
}[] = [
  {
    id: "f1",
    kind: "Tip",
    tone: "success",
    who: "Fernsby",
    what: "tipped",
    amount: { cents: 500 },
    message: "“that glaze!!”",
    ago: "12 s ago",
  },
  { id: "f2", kind: "Gift", tone: "accent", who: "paperlantern", what: "gifted 5 Tier 1 subs", ago: "2 min ago" },
  { id: "f3", kind: "Raid", tone: "info", who: "Lumen Kitchen", what: "raided with 34 viewers", ago: "6 min ago" },
  { id: "f4", kind: "Sub", tone: "accent", who: "ohmslaw", what: "subscribed at Tier 2 · 8 months", ago: "9 min ago" },
  { id: "f5", kind: "Follow", tone: "neutral", who: "tapehead99", what: "followed", ago: "11 min ago" },
  { id: "f6", kind: "Follow", tone: "neutral", who: "quietfox", what: "followed", ago: "14 min ago" },
  {
    id: "f7",
    kind: "Points",
    tone: "neutral",
    who: "nightcap",
    what: "redeemed “Pick the next glaze”",
    ago: "18 min ago",
  },
];
