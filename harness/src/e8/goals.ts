// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 4 (goal overlay) (docs/testing/e8-selectors.md, "Scenarios"). Owned by E8-raids-
 * goals; a stub until it lands (the step stays in the pending list until then).
 */
import type { E8Run } from "./kit.ts";

export async function stepGoal(_run: E8Run): Promise<void> {
  throw new Error("E8-raids-goals not merged");
}
