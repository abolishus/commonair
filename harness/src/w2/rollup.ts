// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extension `group` (docs/testing/w2-selectors.md, "Scenarios"; ADR 0014):
 * after the settle override, the swarm is one `datacenter` excluded group with the expected
 * session count. Stub: W2-rollup-analytics fills it.
 */
import type { IntegrityW2Extension } from "./kit.ts";

export async function stepGroup(_ext: IntegrityW2Extension): Promise<void> {
  throw new Error("W2-rollup-analytics not merged");
}
