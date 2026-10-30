// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export type PresentationKind = "chat" | "alert";

export interface PresentationItem {
  kind: PresentationKind;
  mediaTs: string | null;
  own: boolean;
}

/** ADR 0012 amendment 1 decision 3: hold an item until the playhead reaches its media time (alerts on, chat off by default, own messages never held, at most 60 s, nothing held in DVR mode). */
export interface PresentationQueue {
  /** Calls `show` now or when the playhead reaches `item.mediaTs`. */
  present<T extends PresentationItem>(item: T, show: (item: T) => void): void;
  /** Per-device opt-in to sync chat lines (localStorage, default off). */
  syncChat: boolean;
  dispose(): void;
}

export function presentationQueue(_opts: { channel: string; creatorView: boolean }): PresentationQueue {
  return { present: (item, show) => show(item), syncChat: false, dispose: () => {} }; // W1-player
}
