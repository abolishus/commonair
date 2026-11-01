// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e5-coop` W3 extension `jury` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0038): turn
 * `jury.enabled` on, opt in 12 members, seed closed T1/T2 cases (and one T0 and one NCII case),
 * run the draw hook, the jurors vote, close, and check the suppressed results, the
 * majority-disagree flag, that no T0 or NCII case was sampled and that the seed matches its
 * commitment. Stub: W3-jury fills it.
 */
import type { CoopW3Extension } from "./kit.ts";

export async function stepJury(_ext: CoopW3Extension): Promise<void> {
  throw new Error("W3-jury not merged");
}
