// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 1 (E9-apps): register a confidential and a public app over the API, update, rotate the secret.
 * Owned by E9-apps; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "apps",
  owner: "E9-apps",
  ready: false,
  needs: [],
  run: notMerged("E9-apps"),
};
