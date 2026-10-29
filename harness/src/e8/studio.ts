// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 5 and `channel-bot` step 6 (the studio pages) (docs/testing/e8-selectors.md,
 * "Scenarios"). Owned by E8-studio; a stub until it lands (the step stays in the pending list
 * until then).
 */
import type { E8Run } from "./kit.ts";

export async function stepInteractStudio(_run: E8Run): Promise<void> {
  throw new Error("E8-studio not merged");
}

export async function stepBotStudio(_run: E8Run): Promise<void> {
  throw new Error("E8-studio not merged");
}
