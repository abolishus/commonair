// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StreamCard } from "@commonair/contracts/dto";

export type DirectorySectionId = "spotlight" | "new" | "live" | "following";

export interface DirectoryHome {
  spotlight: StreamCard[];
  newAndLive: StreamCard[];
  live: StreamCard[];
  following: StreamCard[];
}

export interface DirectorySection {
  id: DirectorySectionId;
  cards: StreamCard[];
}

/**
 * The sections the front page renders, in order: spotlight, new, live, following. Empty sections
 * are dropped, and `following` is only shown to signed-in viewers.
 */
export function directorySections(home: DirectoryHome, signedIn: boolean): DirectorySection[] {
  const all: DirectorySection[] = [
    { id: "spotlight", cards: home.spotlight },
    { id: "new", cards: home.newAndLive },
    { id: "live", cards: home.live },
    { id: "following", cards: signedIn ? home.following : [] },
  ];
  return all.filter((s) => s.cards.length > 0);
}
