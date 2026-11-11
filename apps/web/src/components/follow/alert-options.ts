// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which answers the first-follow alert prompt offers (README D4.3, ux-journeys J1-f). Push needs
 * a service worker, `PushManager` and `Notification`. iOS and iPadOS Safari only expose
 * `PushManager` once the site is on the Home Screen (16.4+), so there the prompt never offers a
 * dead Push: it offers Email and an "Add to Home Screen" hint. Feature detection only: the hint
 * keys off `navigator.standalone`, which only Apple's WebKit defines.
 */

export interface AlertEnv {
  /** `serviceWorker`, `PushManager` and `Notification` all exist. */
  pushSupported: boolean;
  /** `navigator.standalone` exists (Apple's mobile WebKit), whatever its value. */
  appleStandaloneApi: boolean;
  /** Running from the Home Screen (`display-mode: standalone`, or `navigator.standalone`). */
  standalone: boolean;
}

export interface AlertOptions {
  push: boolean;
  /** Show "Add {site} to your Home Screen" (push would work once installed). */
  installHint: boolean;
}

/** The prompt's answers for a browser. Email and Not now are always offered. */
export function alertOptions(env: AlertEnv): AlertOptions {
  if (env.pushSupported) return { push: true, installHint: false };
  // An Apple mobile browser outside the Home Screen: installing is what turns push on.
  return { push: false, installHint: env.appleStandaloneApi && !env.standalone };
}

interface NavigatorLike {
  serviceWorker?: unknown;
  standalone?: boolean;
}
interface WindowLike {
  PushManager?: unknown;
  Notification?: unknown;
  matchMedia?: (query: string) => { matches: boolean };
}

/** This browser's `AlertEnv` (all false on the server). */
export function browserAlertEnv(
  win: WindowLike | undefined = typeof window === "undefined" ? undefined : (window as unknown as WindowLike),
  nav: NavigatorLike | undefined = typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike),
): AlertEnv {
  if (!win || !nav) return { pushSupported: false, appleStandaloneApi: false, standalone: false };
  const pushSupported = "serviceWorker" in nav && "PushManager" in win && "Notification" in win;
  const appleStandaloneApi = "standalone" in nav;
  let displayStandalone = false;
  try {
    displayStandalone = win.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    displayStandalone = false;
  }
  return { pushSupported, appleStandaloneApi, standalone: displayStandalone || nav.standalone === true };
}

/**
 * The first follow the server reported (`channels.follow` → `firstFollow`) goes to the Follow
 * control that was pressed, so a page with Follow twice (the header and the offline hero) shows
 * one prompt. A control arms itself on click; `useFollow` fires once the API answers.
 */
let armed: (() => void) | null = null;

/** Arm `onFirstFollow` for the next reported first follow; returns a disarm. */
export function armFirstFollow(onFirstFollow: () => void): () => void {
  armed = onFirstFollow;
  return () => {
    if (armed === onFirstFollow) armed = null;
  };
}

/** The API said this follow was the caller's first: tell the armed control, once. */
export function fireFirstFollow(): boolean {
  const target = armed;
  armed = null;
  if (!target) return false;
  target();
  return true;
}
