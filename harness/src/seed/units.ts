// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Every seed unit, and the order they run in (dependencies first, otherwise as listed). */
import { unit as coop } from "./coop.ts";
import { unit as interact } from "./interact.ts";
import { unit as media } from "./media.ts";
import { unit as money } from "./money.ts";
import { unit as platform } from "./platform.ts";
import { unit as safety } from "./safety.ts";
import { unit as social } from "./social.ts";
import type { SeedUnit } from "./types.ts";

export const SEED_UNITS: readonly SeedUnit[] = [social, interact, money, coop, safety, platform, media];

/** Topological order; throws on a cycle or an unknown dependency. Pure. */
export function orderUnits(units: readonly SeedUnit[]): SeedUnit[] {
  const byName = new Map(units.map((u) => [u.name, u]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: SeedUnit[] = [];
  const visit = (u: SeedUnit) => {
    if (done.has(u.name)) return;
    if (visiting.has(u.name)) throw new Error(`seed: dependency cycle through ${u.name}`);
    visiting.add(u.name);
    for (const dep of u.after) {
      const d = byName.get(dep);
      if (!d) throw new Error(`seed: ${u.name} runs after unknown unit ${dep}`);
      visit(d);
    }
    visiting.delete(u.name);
    done.add(u.name);
    out.push(u);
  };
  for (const u of units) visit(u);
  return out;
}
