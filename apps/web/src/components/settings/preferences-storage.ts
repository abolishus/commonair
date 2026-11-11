// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Preferences that only shape this browser (D7.1 P7): kept in `localStorage` per device, every
 * read and write in try/catch so a private window or blocked storage falls back to the default.
 */
export const AUTOPLAY_PREVIEWS_KEY = "commonair:autoplay-previews";

type Store = Pick<Storage, "getItem" | "setItem">;

/** `localStorage`, or null where touching it throws. */
export function browserStore(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The OS asks for less motion: previews then start off until the member turns them on. */
export function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/** Whether stream previews may play by themselves. Default: on, unless reduced motion is asked for. */
export function readAutoplayPreviews(store: Pick<Storage, "getItem"> | null, reducedMotion: boolean): boolean {
  try {
    const raw = store?.getItem(AUTOPLAY_PREVIEWS_KEY) ?? null;
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // Unreadable storage: the default.
  }
  return !reducedMotion;
}

/** False when the browser refused to keep it (private mode, quota). */
export function saveAutoplayPreviews(store: Pick<Storage, "setItem"> | null, on: boolean): boolean {
  if (!store) return false;
  try {
    store.setItem(AUTOPLAY_PREVIEWS_KEY, on ? "on" : "off");
    return true;
  } catch {
    return false;
  }
}
