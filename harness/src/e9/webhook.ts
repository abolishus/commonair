// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 4 (E9-subs): webhook subscription to channel.follow, delivery, signature, log, test event, redelivery, refusals.
 * Owned by E9-subs; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "webhook",
  owner: "E9-subs",
  ready: false,
  needs: [2],
  run: notMerged("E9-subs"),
};
