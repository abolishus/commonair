// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Content board (videos & clips). */
import type { StatusTone } from "@commonair/ui";

export const tabs = [
  { id: "broadcasts", label: "Past broadcasts", href: "#content", current: true, count: 23 },
  { id: "highlights", label: "Highlights", href: "#content/highlights", count: 6 },
  { id: "uploads", label: "Uploads", href: "#content/uploads" },
  { id: "clips", label: "Clips", href: "#content/clips", count: 142 },
];

export const visibilities = [
  { value: "all", label: "All visibility" },
  { value: "public", label: "Public" },
  { value: "subscribers", label: "Subscribers" },
  { value: "private", label: "Private" },
];

export interface VideoRow {
  id: string;
  title: string;
  date: string;
  category: string;
  duration: string;
  visibility: string;
  tone: StatusTone;
  views: string;
  expires: string;
  /** Selected on the board ("2 selected"). */
  selected: boolean;
}

const tone = (visibility: string): StatusTone =>
  visibility === "Public" ? "success" : visibility === "Highlight" ? "accent" : visibility.startsWith("Muted") ? "warning" : "neutral";

export const videos: VideoRow[] = (
  [
    ["Glaze tests: copper reds, round 4", "Oct 17", "Makers & Crafting", "3:12:04", "Public", "412", "in 60 days", true],
    ["Throwing big bowls, viewer challenges", "Oct 15", "Makers & Crafting", "2:48:51", "Public", "1,208", "in 58 days", true],
    ["Kiln unloading — the moment of truth", "Oct 12", "Makers & Crafting", "1:55:10", "Highlight", "4,981", "never", false],
    ["Trimming and Q&A", "Oct 10", "Makers & Crafting", "2:30:22", "Subscribers", "366", "in 53 days", false],
    ["Glaze tests: copper reds, round 3", "Oct 8", "Makers & Crafting", "3:05:39", "Public", "702", "in 51 days", false],
    ["Studio tour + music (muted segments)", "Oct 5", "Just Chatting", "1:12:48", "Muted 0:12", "230", "in 48 days", false],
    ["Glaze chemistry for beginners", "Oct 3", "Makers & Crafting", "0:48:15", "Private", "0", "in 46 days", false],
  ] as const
).map(([title, date, category, duration, visibility, views, expires, selected], index) => ({
  id: `v${index + 1}`,
  title,
  date,
  category,
  duration,
  visibility,
  tone: tone(visibility),
  views,
  expires,
  selected,
}));

export const notes = {
  retention: "Past broadcasts are kept 60 days. Highlights and uploads are kept until you delete them. Storage used: 48.2 GB.",
  claim: "1 video is muted for a copyright claim.",
};
