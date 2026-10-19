// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Search board (results for "synth"). */
import type { Accent } from "@commonair/ui";
import type { CategoryTileData, MediaCardData } from "@commonair/ui/blocks/media";

export const tabs = [
  { id: "all", label: "All", href: "#search?q=synth", current: true },
  { id: "channels", label: "Channels", href: "#search?q=synth&type=channels" },
  { id: "categories", label: "Categories", href: "#search?q=synth&type=categories" },
  { id: "live", label: "Live", href: "#search?q=synth&type=live" },
  { id: "videos", label: "Videos", href: "#search?q=synth&type=videos" },
];

export interface ChannelResult {
  name: string;
  accent: Accent;
  live: boolean;
  member: boolean;
  sub: string;
  followers: string;
}

export const channels: ChannelResult[] = [
  { name: "Tinwhistle", accent: "sky", live: true, member: true, sub: "Live: Late-night synth jam — requests open", followers: "1.2K" },
  { name: "voltagecontrol", accent: "lime", live: true, member: false, sub: "Live: Modular patch from scratch", followers: "3.4K" },
  { name: "synthesist_ana", accent: "pink", live: false, member: true, sub: "Last live 2 days ago · Music", followers: "806" },
  { name: "synthkid", accent: "orange", live: false, member: false, sub: "Last live 3 weeks ago · Software & Game Dev", followers: "74" },
];

export const categories: (CategoryTileData & { note: string })[] = [
  { id: "music", name: "Music", accent: "indigo", liveCount: 14, viewers: 6400, note: "tag “synth” on 14 streams" },
  { id: "synthwave-racer", name: "Synthwave Racer", accent: "lime", liveCount: 4, viewers: 88, note: "4 live" },
];

export const videos: MediaCardData[] = [
  { id: "v1", title: "Building a 4-voice poly from kits, part 2", channelName: "voltagecontrol", accent: "lime", kind: "Past broadcast", duration: "3:12:40", ago: "2 days ago", views: "1.8K views" },
  { id: "v2", title: "That bass patch everyone asked about", channelName: "Tinwhistle", accent: "sky", kind: "Clip", duration: "0:42", ago: "5 days ago", views: "6.1K views" },
  { id: "v3", title: "Synth basics for total beginners", channelName: "synthesist_ana", accent: "pink", kind: "Highlight", duration: "24:08", ago: "1 week ago", views: "2.3K views" },
];
