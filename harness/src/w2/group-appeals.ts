// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `integrity-basic` W2 extension `group-appeal` (docs/testing/w2-selectors.md, "Scenarios"; ADR
 * 0014 decision 4): an appeal on the swarm's group, the rate limit, an overturn, the re-scored
 * sessions and the `supersede` entry. Stub: W2b-group-appeals fills it.
 */
import type { IntegrityW2Extension } from "./kit.ts";

export async function stepGroupAppeal(_ext: IntegrityW2Extension): Promise<void> {
  throw new Error("W2b-group-appeals not merged");
}
