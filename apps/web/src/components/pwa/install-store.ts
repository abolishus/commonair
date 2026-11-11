// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The install entry's browser state (README D7.6): the held `beforeinstallprompt`, whether the
 * app runs installed, the engagement record in `localStorage` and the iOS steps dialog. One store
 * for the account menu, the You sheet and the offer in context. Storage can be missing or throw
 * (private windows), so every access is guarded; without it the menus still offer installing and
 * the offer in context simply never comes. Nothing here is sent to the server but the closed-list
 * `pwa.install` counters.
 */
import * as React from "react";
import { trackUi } from "../../lib/ui-metrics.ts";
import {
  EMPTY_ENGAGEMENT,
  type Engagement,
  INSTALL_STORAGE_KEY,
  type InstallMode,
  addWatched,
  createWatchClock,
  dismissOffer as dismissed,
  installMode,
  offerDue,
  parseEngagement,
  recordVisit,
  serializeEngagement,
} from "./install-rule.ts";

/** The part of `BeforeInstallPromptEvent` used here (not in the DOM typings). */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallSnapshot {
  mode: InstallMode;
  /** The offer in context is due by the engagement rule (where it shows is the caller's call). */
  offerDue: boolean;
  /** The Add to Home Screen steps dialog is open. */
  iosOpen: boolean;
}

const SERVER: InstallSnapshot = { mode: "none", offerDue: false, iosOpen: false };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readEngagement(store: StorageLike | null = storage()): Engagement {
  if (!store) return EMPTY_ENGAGEMENT;
  try {
    return parseEngagement(store.getItem(INSTALL_STORAGE_KEY));
  } catch {
    return EMPTY_ENGAGEMENT;
  }
}

export function writeEngagement(state: Engagement, store: StorageLike | null = storage()): void {
  if (!store) return;
  try {
    store.setItem(INSTALL_STORAGE_KEY, serializeEngagement(state));
  } catch {
    // Quota or blocked storage: the offer in context is a convenience.
  }
}

let held: InstallPromptEvent | null = null;
let installed = false;
let iosOpen = false;
let snapshot: InstallSnapshot = SERVER;
const listeners = new Set<() => void>();

function standalone(): boolean {
  if (installed) return true;
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches === true) return true;
  } catch {
    // An old browser without matchMedia: fall through to Apple's flag.
  }
  return (navigator as { standalone?: boolean }).standalone === true;
}

function refresh(): void {
  const mode = installMode({
    standalone: standalone(),
    promptReady: held !== null,
    promptSupported: "onbeforeinstallprompt" in window,
    appleStandaloneApi: "standalone" in navigator,
  });
  const due = offerDue(readEngagement());
  if (snapshot.mode === mode && snapshot.offerDue === due && snapshot.iosOpen === iosOpen) return;
  snapshot = { mode, offerDue: due, iosOpen };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The install state for rendering ("none" on the server and until `startInstallWatch` ran). */
export function useInstall(): InstallSnapshot {
  return React.useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => SERVER,
  );
}

/** Where an install began, for the counters' sake only. */
export type InstallSource = "menu" | "offer";

/** The offer in context has had its answer: it does not come back (the menus still offer it). */
function settleOffer(): void {
  const state = readEngagement();
  if (!state.dismissed) writeEngagement(dismissed(state));
}

/**
 * "Install" chosen in a menu or the offer: the browser's own dialog where one is held, else the
 * Add to Home Screen steps. Resolves to the outcome ("ios" when the steps opened). Either way the
 * offer in context has been answered and stays away.
 */
export async function requestInstall(onAccepted: () => void = () => undefined): Promise<string> {
  trackUi("pwa.install", "click");
  const event = held;
  if (!event) {
    if (snapshot.mode !== "ios") return "unavailable";
    settleOffer();
    iosOpen = true;
    refresh();
    return "ios";
  }
  // A held event can be prompted once.
  held = null;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    settleOffer();
    if (outcome === "accepted") {
      installed = true;
      onAccepted();
    } else {
      trackUi("pwa.install", "dismiss");
    }
    return outcome;
  } catch {
    return "unavailable";
  } finally {
    refresh();
  }
}

/** "Not now" on the offer in context: it never comes back. */
export function dismissInstallOffer(): void {
  trackUi("pwa.install", "dismiss");
  writeEngagement(dismissed(readEngagement()));
  refresh();
}

export function closeIosSteps(): void {
  iosOpen = false;
  refresh();
}

/** Media events that end a playing stretch (they do not bubble, so they are caught on the way down). */
const STOPS = ["pause", "ended", "waiting", "emptied", "abort", "error"] as const;
/** A long stretch is saved this often, so a closed tab loses little. */
const FLUSH_MS = 30_000;

let started = false;

function onPrompt(event: Event): void {
  // The menus and the offer show the dialog when the viewer asks, not the browser's own bar.
  event.preventDefault();
  held = event as InstallPromptEvent;
  refresh();
}

function onInstalled(): void {
  installed = true;
  held = null;
  refresh();
}

// Chromium fires `beforeinstallprompt` once per page load and can do so before hydration, so the
// store listens from the moment the shell bundle loads it rather than from `startInstallWatch`.
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
}

/** Still playing on the page: a player unmounted mid-play leaves without its `pause`. */
function stillPlaying(video: object): boolean {
  return video instanceof HTMLVideoElement && video.isConnected && !video.paused && !video.ended;
}

/**
 * Start once per page load (the PWA root does, after hydration): count this page load as a visit
 * when it is one, and time playing videos from their own media events (the players' existing
 * signals; nothing added to them). Returns a stop.
 */
export function startInstallWatch(now: () => number = Date.now): () => void {
  if (started || typeof window === "undefined") return () => undefined;
  started = true;
  writeEngagement(recordVisit(readEngagement(), now()));

  const clock = createWatchClock();
  const flush = () => {
    // Before taking time: a video gone from the page (or stopped unheard) counts only up to the
    // last flush, so browsing away from a watch page stops the clock.
    clock.sweep(stillPlaying);
    const ms = clock.take(now());
    if (ms <= 0) return;
    writeEngagement(addWatched(readEngagement(), ms, now()));
    refresh();
  };
  const onPlaying = (event: Event) => {
    if (event.target instanceof HTMLVideoElement) clock.start(event.target, now());
  };
  const onStop = (event: Event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    clock.stop(event.target, now());
    flush();
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") flush();
  };
  const timer = window.setInterval(() => {
    if (clock.playing) flush();
  }, FLUSH_MS);

  document.addEventListener("playing", onPlaying, true);
  for (const type of STOPS) document.addEventListener(type, onStop, true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", flush);
  refresh();

  return () => {
    flush();
    window.clearInterval(timer);
    document.removeEventListener("playing", onPlaying, true);
    for (const type of STOPS) document.removeEventListener(type, onStop, true);
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", flush);
    started = false;
  };
}

/** Tests only: forget the module's state between cases. */
export function resetInstallStore(): void {
  held = null;
  installed = false;
  iosOpen = false;
  started = false;
  snapshot = SERVER;
  listeners.clear();
}
