// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Plugin } from "vite-plus";

/** Builds the service worker (`src/sw/**` → `/sw.js`) and the app-shell precache list (ADR 0028 decision 7). Stub until N1-pwa fills it. */
export function pwa(): Plugin {
  return { name: "commonair-pwa" };
}
