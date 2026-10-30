// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 3 (N1-fanout): a restart within the cooldown notifies no one again. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "cooldown",
  owner: "N1-fanout",
  needs: [1],
  run: notMerged("N1-fanout"),
};
