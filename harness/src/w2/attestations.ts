// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extensions `signed` and `tamper` (docs/testing/w2-selectors.md,
 * "Scenarios"; ADR 0014). Stub: W2b-attestations fills it.
 */
import type { IntegrityW2Extension } from "./kit.ts";

/** The broadcast's statement verifies with the SDK verifier and its figures equal the session verdicts. */
export async function stepSigned(_ext: IntegrityW2Extension): Promise<void> {
  throw new Error("W2b-attestations not merged");
}

/** A modified payload and a modified stored row both fail verification. */
export async function stepTamper(_ext: IntegrityW2Extension): Promise<void> {
  throw new Error("W2b-attestations not merged");
}
