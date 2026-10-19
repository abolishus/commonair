// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Browse board. */
import type { Accent } from "@commonair/ui";
import type { CategoryTileData } from "@commonair/ui/blocks/media";

const rows: [string, Accent, number, number, string][] = [
  ["Just Chatting", "zinc", 18200, 412, "IRL"],
  ["Music", "indigo", 6400, 188, "Creative"],
  ["Hollow Depths", "amber", 5900, 96, "Competitive"],
  ["Art", "pink", 3100, 143, "Creative"],
  ["Science & Technology", "teal", 2800, 61, "Educational"],
  ["Speedrunning", "lime", 2200, 74, "Competitive"],
  ["Food & Drink", "green", 1500, 39, "IRL"],
  ["Meadowlight", "lime", 1400, 52, "Cozy"],
  ["Software & Game Dev", "sky", 1200, 58, "Educational"],
  ["Retro", "orange", 1100, 47, "Nostalgia"],
  ["Tabletop RPGs", "violet", 980, 22, "Creative"],
  ["Chess", "zinc", 910, 31, "Competitive"],
  ["Fitness & Health", "red", 640, 19, "IRL"],
  ["Makers & Crafting", "amber", 590, 27, "Creative"],
  ["Starfall Tactics", "blue", 530, 18, "Strategy"],
  ["Co-op", "zinc", 204, 3, "Governance"],
  ["Travel & Outdoors", "teal", 188, 9, "IRL"],
  ["Podcasts", "indigo", 160, 12, "Talk"],
];

export const categories: CategoryTileData[] = rows.map(([name, accent, viewers, liveCount, tag]) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
  name,
  accent,
  viewers,
  liveCount,
  tags: [tag],
}));

export const tabs = [
  { id: "categories", label: "Categories", href: "#browse", current: true },
  { id: "live", label: "Live channels", href: "#category/music" },
];

export const languages = [
  { value: "all", label: "All languages" },
  { value: "en", label: "English" },
  { value: "es", label: "Español" },
];

export const tags = ["All", "Cozy", "Competitive", "Creative", "IRL", "Mature"].map((label) => ({
  value: label.toLowerCase(),
  label,
}));

export const sorts = [
  { value: "viewers", label: "Viewers (high to low)" },
  { value: "channels", label: "Channels live" },
  { value: "az", label: "A–Z" },
];
