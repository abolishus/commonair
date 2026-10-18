// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Page lifecycle for a playback session. A page that is really unloading ends its session; one
 * going into the back/forward cache (`persisted`) keeps it, and when it is restored from there
 * the player starts a fresh session (the old one went stale while the page was frozen).
 */
export function pageLifecycle(
  stop: () => void,
  restart: () => void,
): { pagehide: (e: { persisted: boolean }) => void; pageshow: (e: { persisted: boolean }) => void } {
  return {
    pagehide: (e) => {
      if (!e.persisted) stop();
    },
    pageshow: (e) => {
      if (e.persisted) restart();
    },
  };
}
