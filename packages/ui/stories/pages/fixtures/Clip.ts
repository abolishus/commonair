// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Clip board (create a clip, clip published). */
import type { MediaCardData } from "@commonair/ui/blocks/media";

export const clip = {
  channel: "rivertide",
  accent: "teal" as const,
  preview: "Previewing 0:30 of the last 90 seconds",
  previewTime: "0:12 / 0:30",
  window: 90,
  range: [27, 57] as [number, number],
  minDuration: 5,
  maxDuration: 60,
  title: "The azimuth reveal",
};

export const published = {
  description: "“Tape deck finally sings” · 0:42 · from rivertide",
  link: "/rivertide/clip/tape-deck-finally-sings",
  embed: '<iframe src="/embed/clip/tape-deck-finally-sings" allowfullscreen></iframe>',
};

export const more: MediaCardData[] = [
  { id: "m1", title: "Capacitor goes pop, chat goes wild", accent: "teal", duration: "0:19", views: "12K views · 3 days ago" },
  { id: "m2", title: "How to read a schematic in 60 seconds", accent: "teal", duration: "0:58", views: "4.4K views · 1 week ago" },
  { id: "m3", title: "The world’s slowest desolder", accent: "teal", duration: "0:33", views: "2.1K views · 2 weeks ago" },
  { id: "m4", title: "VU meters dancing for the first time", accent: "teal", duration: "0:25", views: "1.7K views · 3 weeks ago" },
];

/** Seconds relative to "now", as the board's axis reads them (−1:30 … now). */
export function formatOffset(seconds: number): string {
  const back = clip.window - seconds;
  if (back <= 0) return "now";
  return `−${Math.floor(back / 60)}:${String(back % 60).padStart(2, "0")}`;
}

export function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
