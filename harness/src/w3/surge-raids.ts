// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` W3 extension `surge-raid` (docs/testing/b7-selectors.md, "Scenarios"; ADR 0039): the
 * target turns the guard on with raids protected, a source with three verified viewers and a
 * viewbot swarm raids it, the surge opens with `trigger: "raid"`, the verified raiders chat and the
 * bots get the surge notice, and a moderator override ends it. Stub: W3-surge-raids fills it.
 */
import type { InteractW3Extension } from "./kit.ts";

export async function stepSurgeRaid(_run: InteractW3Extension): Promise<void> {
  throw new Error("W3-surge-raids not merged");
}
