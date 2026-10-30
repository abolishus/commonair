// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 6 (N1-pwa, web only): the manifest, installability, the service worker and its push handler. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "PWA",
  owner: "N1-pwa",
  needs: [],
  webOnly: true,
  run: notMerged("N1-pwa"),
};
