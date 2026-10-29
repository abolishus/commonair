// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 1 (poll) (docs/testing/e8-selectors.md, "Scenarios"). Owned by E8-polls; a stub
 * until it lands (the step stays in the pending list until then).
 */
import type { E8Run } from "./kit.ts";

export async function stepPoll(_run: E8Run): Promise<void> {
  throw new Error("E8-polls not merged");
}
