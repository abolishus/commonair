// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 1 (N1-fanout): a follower gets one in-app `go_live` row when the channel goes live. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "in-app",
  owner: "N1-fanout",
  needs: [],
  run: notMerged("N1-fanout"),
};
