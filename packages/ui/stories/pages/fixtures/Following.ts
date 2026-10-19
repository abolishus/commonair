// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Following board. */
import type { Accent } from "@commonair/ui";
import type { CategoryTileData } from "@commonair/ui/blocks/media";
import { liveStream } from "./streams.ts";

export const tabs = [
  { id: "overview", label: "Overview", href: "#following", current: true },
  { id: "live", label: "Live", href: "#following/live", count: 5 },
  { id: "videos", label: "Videos", href: "#following/videos" },
  { id: "categories", label: "Categories", href: "#following/categories" },
  { id: "channels", label: "Channels", href: "#following/channels" },
];

/** `uptime` is on the board's thumbnails; StreamCard has no uptime overlay yet (contract request). */
export const live = [
  {
    title: "Rebuilding a 1970s tape deck",
    name: "rivertide",
    accent: "teal",
    category: "Science & Technology",
    viewers: 2400,
    uptime: "3:41:09",
  },
  {
    title: "Friday house set from the balcony",
    name: "DJ Halcyon",
    accent: "indigo",
    category: "Music",
    viewers: 1100,
    uptime: "1:12:55",
  },
  {
    title: "Ranked grind to Diamond — chat picks my loadout",
    name: "Okonkwo Plays",
    accent: "amber",
    category: "Hollow Depths",
    viewers: 318,
    uptime: "5:02:17",
  },
  {
    title: "Watercolor landscapes, slow and quiet",
    name: "paperlantern",
    accent: "pink",
    category: "Art",
    viewers: 87,
    uptime: "0:48:30",
  },
  {
    title: "Any% WR attempts, reset counter on screen",
    name: "grumblebee",
    accent: "lime",
    category: "Speedrunning",
    viewers: 42,
    uptime: "2:20:03",
  },
].map(({ uptime: _uptime, accent, ...row }) => liveStream({ ...row, accent: accent as Accent, reason: "following" }));

export const offline: { name: string; accent: Accent; last: string; next: string }[] = [
  { name: "synthesist_ana", accent: "pink", last: "Live 2 days ago · Music", next: "Tomorrow 19:00" },
  { name: "Wren & Ash", accent: "amber", last: "Live 4 days ago · Music", next: "Sat 20:00" },
  { name: "boardgame.bureau", accent: "violet", last: "Live 1 week ago · Tabletop RPGs", next: "Sun 18:00" },
  { name: "Lumen Kitchen", accent: "green", last: "Live yesterday · Food & Drink", next: "Not scheduled" },
  { name: "kanjikat", accent: "red", last: "Live 3 days ago · Just Chatting", next: "Mon 12:00" },
  { name: "stackframe", accent: "sky", last: "Live 2 weeks ago · Software & Game Dev", next: "Not scheduled" },
];

export const offlineSorts = [
  { value: "recent", label: "Recently live" },
  { value: "next", label: "Next scheduled" },
  { value: "az", label: "A–Z" },
];

export const followedCategories: CategoryTileData[] = [
  { id: "music", name: "Music", accent: "indigo", liveCount: 188, viewers: 6400 },
  { id: "art", name: "Art", accent: "pink", liveCount: 143, viewers: 3100 },
  { id: "science", name: "Science & Tech", accent: "teal", liveCount: 61, viewers: 2800 },
];
