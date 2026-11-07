// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First-party UI counters (overhaul wave 2, D2.8; growth-funnels.md P7 B). One fire-and-forget
 * `POST /api/metrics/ui` per view or click: closed lists only, no cookie, no ids. Nothing is sent
 * when the browser asks not to be tracked (Global Privacy Control or Do Not Track), and a view is
 * counted once per page load.
 */
import type { UI_METRIC_ACTIONS, UI_METRIC_STEPS, UI_METRIC_SURFACES } from "@commonair/contracts/enums";

export type UiSurface = (typeof UI_METRIC_SURFACES)[number];
export type UiAction = (typeof UI_METRIC_ACTIONS)[number];
export type UiStep = (typeof UI_METRIC_STEPS)[number];

export const UI_METRICS_PATH = "/api/metrics/ui";

interface PrivacyNavigator {
  globalPrivacyControl?: boolean;
  doNotTrack?: string | null;
}

/** True when the browser signals that it does not want to be counted. */
export function optedOut(nav: PrivacyNavigator | undefined): boolean {
  if (!nav) return true;
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || nav.doNotTrack === "yes";
}

const viewed = new Set<string>();

/** Where `trackUi` sends from; tests pass their own. */
export interface UiMetricsEnv {
  send: (url: string, init: RequestInit) => Promise<unknown>;
  nav: PrivacyNavigator | undefined;
}

function browserEnv(): UiMetricsEnv | null {
  if (typeof window === "undefined" || typeof fetch !== "function") return null;
  return { send: (url, init) => fetch(url, init), nav: globalThis.navigator as PrivacyNavigator | undefined };
}

/** Count one UI event. Never throws, never awaits; a no-op on the server and when opted out. */
export function trackUi(
  surface: UiSurface,
  action: UiAction,
  step: UiStep = "none",
  env: UiMetricsEnv | null = browserEnv(),
): void {
  if (!env || optedOut(env.nav)) return;
  if (action === "view") {
    const key = `${surface}|${step}`;
    if (viewed.has(key)) return;
    viewed.add(key);
  }
  try {
    void env
      .send(UI_METRICS_PATH, {
        method: "POST",
        keepalive: true,
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface, action, step }),
      })
      .catch(() => undefined);
  } catch {
    // Counting is best effort.
  }
}

/** Tests only: forget which views were counted. */
export function resetUiMetricsForTests(): void {
  viewed.clear();
}
