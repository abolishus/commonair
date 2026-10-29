// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 7 (E9-console): register an app in /developer, its subscriptions and deliveries, a test event, redelivery, a bot token, /admin/apps.
 * Owned by E9-console; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "console",
  owner: "E9-console",
  ready: false,
  needs: [4],
  webOnly: true,
  run: notMerged("E9-console"),
};
