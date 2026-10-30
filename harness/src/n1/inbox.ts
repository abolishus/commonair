// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 5 (N1-inbox, web only): the bell, mark all read, and the settings page. */
import { type N1Step, notMerged } from "./run.ts";

export const step: N1Step = {
  name: "inbox",
  owner: "N1-inbox",
  needs: [1],
  webOnly: true,
  run: notMerged("N1-inbox"),
};
