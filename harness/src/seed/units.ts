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
import type { SeedUnit, SeedUnitName } from "./types.ts";

export const SEED_UNITS: readonly SeedUnit[] = [social, interact, money, coop, safety, platform, media];

type UnitDeps = Pick<SeedUnit, "name" | "after">;

/** Topological order; throws on a cycle or an unknown dependency. Pure. */
export function orderUnits<U extends UnitDeps>(units: readonly U[]): U[] {
  const byName = new Map(units.map((u) => [u.name, u]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: U[] = [];
  const visit = (u: U) => {
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

/**
 * Units of `units` (in its order) that may start: not started, and every unit they wait for is
 * done or outside `units` (a resume's earlier units ran in an earlier run). Pure.
 */
export function readyUnits(
  units: readonly UnitDeps[],
  done: ReadonlySet<SeedUnitName>,
  started: ReadonlySet<SeedUnitName>,
): SeedUnitName[] {
  const selected = new Set(units.map((u) => u.name));
  return units
    .filter((u) => !started.has(u.name) && u.after.every((d) => done.has(d) || !selected.has(d)))
    .map((u) => u.name);
}

/**
 * Wall time of `units` run side by side as `runUnits` does, from each unit's seconds: a unit
 * starts when the last unit it waits for ends. Pure (the shard estimate in harness/src/shards.ts).
 */
export function graphSeconds(
  units: readonly UnitDeps[],
  seconds: Readonly<Partial<Record<SeedUnitName, number>>>,
): number {
  const ends = new Map<SeedUnitName, number>();
  for (const u of orderUnits(units)) {
    const start = Math.max(0, ...u.after.map((d) => ends.get(d) ?? 0));
    ends.set(u.name, start + (seconds[u.name] ?? 0));
  }
  return Math.max(0, ...ends.values());
}

export interface RunUnitsOptions {
  /**
   * Start each unit as soon as every unit it waits for is done, beside the others that may run.
   * Off: one after another in the given order.
   */
  concurrent: boolean;
  signal?: AbortSignal;
}

/**
 * Run `units` (in `orderUnits` order). After a failure or an abort nothing more starts; the units
 * already running finish first, then the first error is rethrown, so no unit is left writing in
 * the background.
 */
export async function runUnits<U extends UnitDeps>(
  units: readonly U[],
  run: (u: U) => Promise<void>,
  o: RunUnitsOptions,
): Promise<void> {
  if (!o.concurrent) {
    for (const u of units) {
      if (o.signal?.aborted) throw o.signal.reason;
      await run(u);
    }
    return;
  }
  const byName = new Map(units.map((u) => [u.name, u]));
  const done = new Set<SeedUnitName>();
  const started = new Set<SeedUnitName>();
  let running: { p: Promise<void>; settled: boolean }[] = [];
  // A holder, so the callbacks' writes are not narrowed away.
  const state: { failure: { err: unknown } | null } = { failure: null };
  for (;;) {
    if (!state.failure && o.signal?.aborted) state.failure = { err: o.signal.reason };
    if (!state.failure)
      for (const name of readyUnits(units, done, started)) {
        started.add(name);
        const unit = byName.get(name) as U;
        const entry = { p: Promise.resolve(), settled: false };
        entry.p = Promise.resolve()
          .then(() => run(unit))
          .then(
            () => void done.add(name),
            (err: unknown) => void (state.failure ??= { err }),
          )
          .finally(() => {
            entry.settled = true;
          });
        running.push(entry);
      }
    if (running.length === 0) break;
    await Promise.race(running.map((r) => r.p));
    running = running.filter((r) => !r.settled);
  }
  if (state.failure) throw state.failure.err;
}
