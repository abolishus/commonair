// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel bot's username (ADR 0026 decision 6): `<slug>_bot`, then `<slug-prefix>_bot<3 digits>`
 * when that is taken, then `channelbot_<6 hex>` when every derived name is reserved or taken.
 * Pure, so the derivation is unit-tested without a database.
 */
import { usernameProblem } from "../auth/identity.ts";

const MAX_USERNAME = 25;
const SUFFIX = "_bot";
/** How many `<prefix>_bot<ddd>` names to try after `<slug>_bot`. */
export const BOT_USERNAME_DIGIT_TRIES = 5;

export interface BotUsernamePlan {
  /** Derived names in the order to try; empty when the slug makes every derived name reserved. */
  derived: string[];
  /** Last resort, independent of the slug. */
  fallback: string;
}

/** `random` returns a float in [0, 1), like `Math.random`; injectable for tests. */
export function botUsernamePlan(slug: string, random: () => number = Math.random): BotUsernamePlan {
  const s = slug.toLowerCase();
  const primary = `${s.slice(0, MAX_USERNAME - SUFFIX.length)}${SUFFIX}`;
  const derived: string[] = [];
  // A reserved slug (or a reserved prefix such as `mod_`) reserves every name derived from it.
  if (usernameProblem(s) === null && usernameProblem(primary) === null) {
    derived.push(primary);
    const prefix = s.slice(0, MAX_USERNAME - SUFFIX.length - 3);
    const seen = new Set<string>();
    // The guard only matters for a broken `random`; a real one fills five distinct names at once.
    for (let guard = 0; seen.size < BOT_USERNAME_DIGIT_TRIES && guard < 100; guard++) {
      const name = `${prefix}${SUFFIX}${String(Math.floor(random() * 1000)).padStart(3, "0")}`;
      if (seen.has(name)) continue;
      seen.add(name);
      derived.push(name);
    }
  }
  const hex = Array.from({ length: 6 }, () => Math.floor(random() * 16).toString(16)).join("");
  return { derived, fallback: `channelbot_${hex}` };
}
