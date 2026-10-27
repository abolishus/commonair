// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `trust-safety` step 11: statements of reasons (ADR 0019, docs/testing/w0-selectors.md,
 * "Scenarios"). Runs after steps 4–7, whose audit actions it checks. Stub from the W0 contract
 * step; W0-sor owns this file and implements it.
 */
import type { Run } from "./safety-run.ts";

export async function runStatementsStep(_run: Run): Promise<void> {
  throw new Error("W0-sor not merged");
}
