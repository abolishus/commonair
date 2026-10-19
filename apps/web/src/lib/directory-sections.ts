// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ChannelCard, StreamCard } from "@commonair/contracts/dto";

export type DirectorySectionId = "spotlight" | "new" | "live" | "following";

export interface DirectoryHome {
  spotlight: StreamCard[];
  newAndLive: StreamCard[];
  live: StreamCard[];
  following: StreamCard[];
  recentlyLive: ChannelCard[];
  followingOffline: ChannelCard[];
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

export type OfflineSectionId = "following-offline" | "recent";

export interface OfflineSection {
  id: OfflineSectionId;
  cards: ChannelCard[];
}

/**
 * The offline sections below the live ones: the viewer's followed channels, then recently live
 * channels they do not already see there. Empty sections are dropped.
 */
export function offlineSections(home: DirectoryHome, signedIn: boolean): OfflineSection[] {
  const followed = signedIn ? home.followingOffline : [];
  const shown = new Set(followed.map((c) => c.channel.id));
  const all: OfflineSection[] = [
    { id: "following-offline", cards: followed },
    { id: "recent", cards: home.recentlyLive.filter((c) => !shown.has(c.channel.id)) },
  ];
  return all.filter((s) => s.cards.length > 0);
}
