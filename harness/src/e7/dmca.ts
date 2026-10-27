// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 8: DMCA takedown and counter-notice (docs/testing/e7-selectors.md,
 * "Scenarios"). Stub from the E7 contract step; E7-dmca owns this file and implements it.
 */
import type { Run } from "../safety-run.ts";

export async function stepDmca(_run: Run): Promise<void> {
  throw new Error("E7-dmca not merged");
}
