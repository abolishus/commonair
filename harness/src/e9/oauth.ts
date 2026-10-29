// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 2 (E9-oauth): PKCE code flow over the API, refresh rotation, reuse revokes the family, device flow, client credentials.
 * Owned by E9-oauth; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "oauth",
  owner: "E9-oauth",
  ready: false,
  needs: [1],
  run: notMerged("E9-oauth"),
};
