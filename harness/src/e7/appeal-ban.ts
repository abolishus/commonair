// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 9: an overturned appeal lifts the ban (docs/testing/e7-selectors.md,
 * "Scenarios"). Stub from the E7 contract step; E7-appeals owns this file and implements it.
 */
import type { Run } from "../safety-run.ts";

export async function stepAppealLiftsBan(_run: Run): Promise<void> {
  throw new Error("E7-appeals not merged");
}
