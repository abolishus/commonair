// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 7 (N1-pwa, web only): the push toggle subscribes this browser; sign-out removes it. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "push from the browser",
  owner: "N1-pwa",
  needs: [4, 6],
  webOnly: true,
  requires: ["webPush"],
  run: notMerged("N1-pwa"),
};
