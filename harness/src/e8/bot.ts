// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `channel-bot` steps 1, 2, 3 and 5 (commands, points cost, timer, song requests)
 * (docs/testing/e8-selectors.md, "Scenarios"). Owned by E8-bot-engine; a stub until it lands (the
 * step stays in the pending list until then).
 */
import type { E8Run } from "./kit.ts";

export async function stepCommands(_run: E8Run): Promise<void> {
  throw new Error("E8-bot-engine not merged");
}

export async function stepPointsCost(_run: E8Run): Promise<void> {
  throw new Error("E8-bot-engine not merged");
}

export async function stepTimer(_run: E8Run): Promise<void> {
  throw new Error("E8-bot-engine not merged");
}

export async function stepSongRequests(_run: E8Run): Promise<void> {
  throw new Error("E8-bot-engine not merged");
}
