// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 6 (E9-sdk): the same flows through @commonair/sdk.
 * Owned by E9-sdk; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "sdk",
  owner: "E9-sdk",
  ready: false,
  needs: [4, 5],
  run: notMerged("E9-sdk"),
};
