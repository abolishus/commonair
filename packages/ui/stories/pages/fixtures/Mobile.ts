// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Mobile board (channel on a phone). The chat lines are in `Channel.ts`. */
import type { MediaCardData } from "@commonair/ui/blocks/media";

export const channel = {
  name: "rivertide",
  accent: "teal" as const,
  title: "Rebuilding a 1970s tape deck",
  viewers: 2400,
  about: "Electronics repair, restoration and the occasional scrap-bin build. Live most weekdays from 18:00 UTC.",
};

export const videos: MediaCardData[] = [
  { id: "v1", title: "Capacitor goes pop, chat goes wild", accent: "teal", kind: "Clip", duration: "0:19", views: "12K views" },
  { id: "v2", title: "How to read a schematic in 60 seconds", accent: "teal", kind: "Clip", duration: "0:58", views: "4.4K views" },
];
