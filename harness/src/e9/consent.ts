// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 3 (E9-consent): the same through /oauth2/authorize, /activate and /settings/connections in Chromium.
 * Owned by E9-consent; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "consent",
  owner: "E9-consent",
  ready: false,
  needs: [1],
  webOnly: true,
  run: notMerged("E9-consent"),
};
