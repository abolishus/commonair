// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 8 (E9-apps): an admin suspends the app: tokens dead, webhook revoked with a notice, socket closed 4008, audit; delete.
 * Owned by E9-apps; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "suspend",
  owner: "E9-apps",
  ready: false,
  needs: [4, 5],
  run: notMerged("E9-apps"),
};
