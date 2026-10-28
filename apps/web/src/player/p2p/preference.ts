// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The viewer's P2P choice and whether they have seen the IP disclosure, per device in
 * localStorage (docs/testing/p1-selectors.md). Storage can be missing, blocked or partitioned
 * (embeds), so every access is wrapped and falls back to "absent". A change notifies every
 * subscriber on the page (all players and the settings section) and, through the `storage`
 * event, other tabs.
 */
import type { P2PPreference } from "./policy.ts";

export const P2P_PREFERENCE_KEY = "commonair:p2p";
export const P2P_NOTICE_KEY = "commonair:p2p-notice";

export interface P2PPrefs {
  preference: P2PPreference;
  noticeSeen: boolean;
}

/** What a page without storage (or the server) sees. */
export const ABSENT_PREFS: P2PPrefs = Object.freeze({ preference: null, noticeSeen: false });

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let storageSource: () => StorageLike | null = defaultStorage;
/**
 * Where storage is blocked, a choice made on this page still holds for this page: an "off" made
 * in the dialog must not come back on the next read.
 */
let memory: { preference: P2PPreference; noticeSeen: boolean } | null = null;
let cached: P2PPrefs = ABSENT_PREFS;

/** Tests swap the storage (`null` restores the browser's) and forget this page's choices. */
export function setP2PStorage(source: (() => StorageLike | null) | null): void {
  storageSource = source ?? defaultStorage;
  memory = null;
  cached = ABSENT_PREFS;
}

function read(key: string): string | null {
  try {
    return storageSource()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): boolean {
  try {
    const s = storageSource();
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** The current prefs. Same object while nothing changed (for `useSyncExternalStore`). */
export function readP2PPrefs(): P2PPrefs {
  const raw = read(P2P_PREFERENCE_KEY);
  let preference: P2PPreference = raw === "on" || raw === "off" ? raw : null;
  let noticeSeen = read(P2P_NOTICE_KEY) === "seen";
  if (memory) {
    preference = memory.preference ?? preference;
    noticeSeen ||= memory.noticeSeen;
  }
  if (cached.preference === preference && cached.noticeSeen === noticeSeen) return cached;
  cached = { preference, noticeSeen };
  return cached;
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to changes made on this page or in another tab; returns the unsubscribe. */
export function subscribeP2PPrefs(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === P2P_PREFERENCE_KEY || e.key === P2P_NOTICE_KEY) listener();
  };
  const win = typeof window === "undefined" ? null : window;
  win?.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    win?.removeEventListener("storage", onStorage);
  };
}

/**
 * Store the viewer's choice. Choosing happens next to the disclosure (dialog, settings), so it
 * also marks the disclosure seen. Subscribers hear about it even when storage is unavailable.
 */
export function setP2PPreference(preference: "on" | "off"): void {
  const kept = write(P2P_PREFERENCE_KEY, preference) && write(P2P_NOTICE_KEY, "seen");
  memory = kept ? null : { preference, noticeSeen: true };
  notify();
}

/** The first-run notice was dismissed (the disclosure is seen). */
export function markP2PNoticeSeen(): void {
  if (!write(P2P_NOTICE_KEY, "seen")) memory = { preference: memory?.preference ?? null, noticeSeen: true };
  notify();
}
