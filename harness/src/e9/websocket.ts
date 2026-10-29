// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 5 (E9-ws): WebSocket welcome, chat, follow, poll and points notifications, keepalive, 4003, session limit, revocation 4008.
 * Owned by E9-ws; the contract step left it pending. Flip `ready` and implement `run`.
 */
import { type E9Step, notMerged } from "./run.ts";

export const step: E9Step = {
  name: "websocket",
  owner: "E9-ws",
  ready: false,
  needs: [2],
  run: notMerged("E9-ws"),
};
