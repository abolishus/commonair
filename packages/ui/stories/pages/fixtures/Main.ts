// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Main board (home / directory). */
import type { ChannelNavGroup } from "@commonair/ui/layouts";
import type { CategoryTileData } from "@commonair/ui/blocks/media";
import { liveStream } from "./streams.ts";

export const sidebarGroups: ChannelNavGroup[] = [
  {
    id: "followed",
    label: "Followed live",
    channels: [
      { id: "rivertide", name: "rivertide", accent: "teal", category: "Science & Technology", viewers: 2400, live: true, href: "#channel/rivertide" },
      { id: "okonkwo", name: "Okonkwo Plays", accent: "amber", category: "Hollow Depths", viewers: 318, live: true, href: "#channel/okonkwo" },
      { id: "paperlantern", name: "paperlantern", accent: "pink", category: "Art", viewers: 87, live: true, href: "#channel/paperlantern" },
      { id: "halcyon", name: "DJ Halcyon", accent: "indigo", category: "Music", viewers: 1100, live: true, href: "#channel/halcyon" },
      { id: "grumblebee", name: "grumblebee", accent: "lime", category: "Speedrunning", viewers: 42, live: true, href: "#channel/grumblebee" },
    ],
  },
  {
    id: "spotlight",
    label: "Spotlight",
    channels: [
      { id: "tinwhistle", name: "Tinwhistle", accent: "sky", category: "Music", viewers: 23, live: true, href: "#channel/tinwhistle" },
      { id: "quietfox", name: "quietfox", accent: "orange", category: "Just Chatting", viewers: 11, live: true, href: "#channel/quietfox" },
      { id: "lumen", name: "Lumen Kitchen", accent: "green", category: "Food & Drink", viewers: 36, live: true, href: "#channel/lumen" },
    ],
  },
];

export const featured = {
  name: "rivertide",
  accent: "teal" as const,
  category: "Science & Technology",
  viewers: 2400,
  title: "Building a weather station from scrap — day 3, soldering the anemometer",
  tags: ["English", "Electronics", "Chill"],
  note: "Spotlight picks rotate every 30 minutes among member channels under 50 average viewers.",
  rotation: { index: 1, total: 3 },
};

export const newLive = [
  liveStream({ title: "First stream ever! Learning pixel art from zero", name: "mothwing", accent: "violet", category: "Art", viewers: 14, reason: "new", tags: ["Beginner", "English"] }),
  liveStream({ title: "Cozy farm sim, building the second greenhouse", name: "harrowfield", accent: "lime", category: "Meadowlight", viewers: 29, reason: "new", tags: ["Cozy"] }),
  liveStream({ title: "Late-night synth jam — requests open", name: "Tinwhistle", accent: "sky", category: "Music", viewers: 23, reason: "spotlight", tags: ["Synth", "Requests"] }),
  liveStream({ title: "Translating old manga panels live", name: "kanjikat", accent: "red", category: "Just Chatting", viewers: 58, reason: "new", tags: ["Japanese", "Language"] }),
];

export const categories: CategoryTileData[] = [
  { id: "just-chatting", name: "Just Chatting", accent: "zinc", liveCount: 412, viewers: 18200 },
  { id: "music", name: "Music", accent: "indigo", liveCount: 188, viewers: 6400 },
  { id: "hollow-depths", name: "Hollow Depths", accent: "amber", liveCount: 96, viewers: 5900 },
  { id: "art", name: "Art", accent: "pink", liveCount: 143, viewers: 3100 },
  { id: "science", name: "Science & Technology", accent: "teal", liveCount: 61, viewers: 2800 },
  { id: "speedrunning", name: "Speedrunning", accent: "lime", liveCount: 74, viewers: 2200 },
  { id: "food", name: "Food & Drink", accent: "green", liveCount: 39, viewers: 1500 },
];

export const liveNow = [
  liveStream({ title: "Ranked grind to Diamond — chat picks my loadout", name: "Okonkwo Plays", accent: "amber", category: "Hollow Depths", viewers: 318, reason: "popular", tags: ["Competitive", "English"] }),
  liveStream({ title: "Friday house set from the balcony", name: "DJ Halcyon", accent: "indigo", category: "Music", viewers: 1100, reason: "popular", tags: ["DJ", "House"] }),
  liveStream({ title: "Watercolor landscapes, slow and quiet", name: "paperlantern", accent: "pink", category: "Art", viewers: 87, reason: "spotlight", tags: ["Relaxing"] }),
  liveStream({ title: "Any% WR attempts, reset counter on screen", name: "grumblebee", accent: "lime", category: "Speedrunning", viewers: 42, reason: "spotlight", tags: ["Any%"] }),
  liveStream({ title: "Sourdough, round two: the starter survived", name: "Lumen Kitchen", accent: "green", category: "Food & Drink", viewers: 36, reason: "spotlight", tags: ["Baking"] }),
  liveStream({ title: "Q&A about moving abroad, ask me anything", name: "quietfox", accent: "orange", category: "Just Chatting", viewers: 11, reason: "new", tags: ["IRL"] }),
  liveStream({ title: "Co-op council open session: patronage formula", name: "commonair", accent: "zinc", category: "Co-op", viewers: 204, reason: "popular", tags: ["Governance"] }),
  liveStream({ title: "Rebuilding a 1970s tape deck", name: "rivertide", accent: "teal", category: "Science & Technology", viewers: 2400, reason: "popular", tags: ["Repair"] }),
];

export const sortOptions = [
  { value: "fair", label: "Fair mix" },
  { value: "viewers", label: "Most viewers" },
  { value: "recent", label: "Recently started" },
];
