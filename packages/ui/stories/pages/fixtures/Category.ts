// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Category board (Music). */
import type { Accent, StreamCardData } from "@commonair/ui";
import { liveStream } from "./streams.ts";

export const category = {
  name: "Music",
  accent: "indigo" as const,
  meta: "6,412 viewers · 188 live channels · 12.9K followers",
  tags: ["Creative", "Performance", "DJ"],
  description:
    "Live performance, production sessions and listening parties. Streams in this category must carry rights for the music they play.",
};

export const breadcrumbs = [{ label: "Browse", href: "#browse" }, { label: "Music" }];

export const tabs = [
  { id: "live", label: "Live channels", href: "#category/music", current: true },
  { id: "videos", label: "Videos", href: "#category/music/videos" },
  { id: "clips", label: "Clips", href: "#category/music/clips" },
];

const rows: [string, string, Accent, number, StreamCardData["reason"], string[], boolean][] = [
  ["Friday house set from the balcony", "DJ Halcyon", "indigo", 1100, "popular", ["DJ", "House"], false],
  ["Late-night synth jam — requests open", "Tinwhistle", "sky", 23, "spotlight", ["Synth"], false],
  ["Writing a song in one stream, start to master", "Wren & Ash", "amber", 312, "popular", ["Production"], false],
  ["Classical guitar practice, études 1–6", "nylonstring", "orange", 17, "new", ["Classical"], false],
  ["Listening party: new album, first spin", "basementradio", "red", 640, "popular", ["Talk"], true],
  ["Lo-fi beats while I tidy the studio", "cassette.wav", "violet", 58, "spotlight", ["Lo-fi"], false],
  ["Drum covers, chat picks the song", "Rimshot Rosa", "pink", 204, "popular", ["Drums", "Requests"], false],
  ["Choir rehearsal livestream", "Northgate Singers", "teal", 41, "new", ["Vocal"], false],
  ["Modular patch from scratch", "voltagecontrol", "lime", 96, "spotlight", ["Modular"], false],
  ["Folk session from the pub back room", "Harrow & Hound", "green", 133, "popular", ["Folk"], false],
  ["Piano requests until midnight", "ivorykeys", "blue", 275, "popular", ["Piano"], false],
  ["Beat battle practice", "loopsmith", "zinc", 12, "new", ["Hip-hop"], false],
];

export const streams = rows.map(([title, name, accent, viewers, reason, tags, mature]) =>
  liveStream({ title, name, accent, category: "Music", viewers, reason, tags, mature }),
);

export const languages = [
  { value: "all", label: "All languages" },
  { value: "en", label: "English" },
];

export const sorts = [
  { value: "fair", label: "Fair mix" },
  { value: "high", label: "Viewers (high)" },
  { value: "low", label: "Viewers (low)" },
  { value: "new", label: "Newest" },
];
