// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The presentation queue (ADR 0012 amendment 1 decision 3): alerts fire when the viewer's playhead
 * reaches the moment they belong to, not when the server sends them, so a viewer 12 s behind sees
 * the alert with the moment. The playhead comes from the channel's media clock
 * (`player/media-clock.ts`).
 *
 * - `own` items (the viewer's own messages) show at once, always.
 * - `alert` items are held until `playheadWallclock(channel) >= mediaTs`, at most `MAX_HOLD_MS`.
 * - `chat` items show at once unless the viewer turned `syncChat` on (per device, default off).
 * - Nothing is held in DVR mode (the alert belongs to a moment the viewer is not watching), on the
 *   broadcaster's own page (`creatorView`), without a playhead (no player, or before its first
 *   frame), or for items without `mediaTs`.
 * - Order within a kind is kept: an item that is due waits for the held ones before it.
 */
import { playbackMode, playheadWallclock } from "../player/media-clock.ts";

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

/** The longest an item is held (ADR 0012 amendment 1 decision 3). */
export const MAX_HOLD_MS = 60_000;
/**
 * How often held items are checked. A timer rather than `requestAnimationFrame`: frames stop in a
 * hidden tab, which would hold alerts past their 60 s cap, while a hidden tab's timers are only
 * throttled (to about once a second), which is cheap and still releases them.
 */
export const POLL_MS = 250;
/** `localStorage` key of the per-device chat-sync opt-in (`"1"` = on). */
export const SYNC_CHAT_KEY = "commonair:chat-sync";

interface Held {
  /** Epoch ms of the item's media time; null when it has none (due at once, in order). */
  at: number | null;
  /** Epoch ms after which it shows whatever the playhead says. */
  deadline: number;
  show: () => void;
}

function readSyncChat(): boolean {
  try {
    return globalThis.localStorage?.getItem(SYNC_CHAT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSyncChat(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(SYNC_CHAT_KEY, "1");
    else globalThis.localStorage?.removeItem(SYNC_CHAT_KEY);
  } catch {
    // Storage blocked (private mode, policy): the choice lasts for this page only.
  }
}

function epochOf(mediaTs: string | null): number | null {
  if (mediaTs === null) return null;
  const at = Date.parse(mediaTs);
  return Number.isFinite(at) ? at : null;
}

export function presentationQueue(opts: { channel: string; creatorView: boolean }): PresentationQueue {
  const { channel, creatorView } = opts;
  const queues: Record<PresentationKind, Held[]> = { chat: [], alert: [] };
  let syncChat = readSyncChat();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  /** Whether a kind is held at all right now (the item's own fields aside). */
  const holding = (kind: PresentationKind): boolean => {
    if (creatorView || disposed) return false;
    if (kind === "chat" && !syncChat) return false;
    return playbackMode(channel) !== "dvr";
  };

  const due = (h: Held, playhead: number | null, now: number): boolean =>
    h.at === null || playhead === null || playhead >= h.at || now >= h.deadline;

  const drain = (kind: PresentationKind): void => {
    const q = queues[kind];
    const release = !holding(kind);
    const now = Date.now();
    const playhead = playheadWallclock(channel)?.getTime() ?? null;
    while (q.length > 0) {
      const head = q[0];
      if (!head || !(release || due(head, playhead, now))) break;
      q.shift();
      head.show();
    }
  };

  const schedule = (): void => {
    if (disposed || timer !== null) return;
    if (queues.chat.length === 0 && queues.alert.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      drain("alert");
      drain("chat");
      schedule();
    }, POLL_MS);
  };

  return {
    present(item, show) {
      // After `dispose` (an unmount, or React's dev double effects) nothing is held any more.
      if (item.own || !holding(item.kind)) {
        // Order within the kind: a line arriving after a held one never overtakes it.
        if (item.own || queues[item.kind].length === 0) {
          show(item);
          return;
        }
      }
      queues[item.kind].push({ at: epochOf(item.mediaTs), deadline: Date.now() + MAX_HOLD_MS, show: () => show(item) });
      drain(item.kind);
      schedule();
    },
    get syncChat() {
      return syncChat;
    },
    set syncChat(on: boolean) {
      if (on === syncChat) return;
      syncChat = on;
      writeSyncChat(on);
      // Turned off: held lines go out now, in order.
      if (!on) drain("chat");
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queues.chat = [];
      queues.alert = [];
    },
  };
}
