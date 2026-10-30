// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 4 (N1-push): encrypted web push to the harness receiver over the API; a 410 expires it. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "push over the API",
  owner: "N1-push",
  needs: [],
  requires: ["webPush"],
  run: notMerged("N1-push"),
};
