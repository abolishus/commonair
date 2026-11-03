// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Resuming `seed full` from a unit. After each unit succeeds the run writes a checkpoint (the store
 * later units read, and a fingerprint of the database it was written against) to the report
 * directory; `seed full --from <unit>` loads the one taken after the unit before `<unit>`. The
 * database itself is snapshotted and restored outside the harness, which only has the app role:
 * `selfhost.sh seed-mode run` dumps it after every unit and restores it for `--from`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SeedScaleName } from "./scale.ts";
import { SEED_UNIT_NAMES, type SeedStore, type SeedUnit, type SeedUnitName } from "./types.ts";

export const CHECKPOINT_VERSION = 1;

/** `seed-checkpoint-<unit>.json`: written once `<unit>` and every unit before it succeeded. */
export const checkpointFileName = (unit: SeedUnitName) => `seed-checkpoint-${unit}.json`;

/**
 * What identifies the database a checkpoint was written against: its users. UUIDv7 ids are minted
 * at random, so another database (a real instance, another seed) never has the same set, and a
 * failed unit that added users is caught too.
 */
export interface DbFingerprint {
  users: number;
  /** md5 of every user id, in id order. */
  usersHash: string;
}

export interface SeedCheckpoint {
  version: number;
  /** The last unit that succeeded. */
  unit: SeedUnitName;
  /** `host:port/database` (describeTarget), never the credentials. */
  target: string;
  scale: SeedScaleName;
  seed: number;
  /** The run's `now`: a resumed run backdates relative to it, as the first run did. */
  now: string;
  fingerprint: DbFingerprint;
  store: SeedStore;
}

export function writeCheckpoint(dir: string, c: SeedCheckpoint): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, checkpointFileName(c.unit));
  // Write then rename would be atomic, but a torn file only fails to parse, and the guard refuses it.
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  return file;
}

/** The checkpoint after `unit`, or undefined when there is none; throws on a file it cannot use. */
export function readCheckpoint(dir: string, unit: SeedUnitName): SeedCheckpoint | undefined {
  const file = join(dir, checkpointFileName(unit));
  if (!existsSync(file)) return undefined;
  return parseCheckpoint(readFileSync(file, "utf8"), file);
}

/** Pure: validates the shape, so a hand-edited or torn file is refused with a reason. */
export function parseCheckpoint(text: string, file = "checkpoint"): SeedCheckpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not JSON`);
  }
  const c = raw as Partial<SeedCheckpoint> | null;
  const bad = (what: string) => new Error(`${file}: ${what}`);
  if (!c || typeof c !== "object") throw bad("not an object");
  if (c.version !== CHECKPOINT_VERSION) throw bad(`version ${String(c.version)}, expected ${CHECKPOINT_VERSION}`);
  if (!SEED_UNIT_NAMES.includes(c.unit as SeedUnitName)) throw bad(`unknown unit ${String(c.unit)}`);
  if (typeof c.target !== "string" || typeof c.scale !== "string" || typeof c.seed !== "number")
    throw bad("target, scale or seed is missing");
  if (typeof c.now !== "string" || Number.isNaN(Date.parse(c.now))) throw bad("now is not a timestamp");
  const f = c.fingerprint;
  if (!f || typeof f.users !== "number" || typeof f.usersHash !== "string") throw bad("fingerprint is missing");
  const s = c.store;
  if (!s || !Array.isArray(s.users) || !Array.isArray(s.channels) || typeof s.extra !== "object" || !s.extra)
    throw bad("store is missing");
  return c as SeedCheckpoint;
}

/** Removes every checkpoint: a fresh run's must never be mixed with an older run's. */
export function clearCheckpoints(dir: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (/^seed-checkpoint-[a-z]+\.json$/.test(f)) rmSync(join(dir, f));
}

/** Which units a run with `--from`/`--to` runs, and the unit whose checkpoint it resumes from. */
export interface UnitSelection {
  /** The unit before `from` (its checkpoint is loaded), or undefined for a run from the start. */
  resumeAfter: SeedUnitName | undefined;
  run: SeedUnit[];
  /** True when the last unit of the order runs (the run then writes the store file). */
  reachesEnd: boolean;
}

/** Pure. `ordered` is `orderUnits(SEED_UNITS)`; throws on a unit not in it, or `to` before `from`. */
export function selectUnits(ordered: readonly SeedUnit[], from?: SeedUnitName, to?: SeedUnitName): UnitSelection {
  const index = (name: SeedUnitName) => {
    const i = ordered.findIndex((u) => u.name === name);
    if (i < 0) throw new Error(`seed: no unit ${name}`);
    return i;
  };
  const start = from ? index(from) : 0;
  const end = to ? index(to) : ordered.length - 1;
  if (end < start) throw new Error(`seed: --to ${to} runs before --from ${from}`);
  return {
    resumeAfter: start > 0 ? ordered[start - 1]?.name : undefined,
    run: ordered.slice(start, end + 1),
    reachesEnd: end === ordered.length - 1,
  };
}

export interface ResumeInput {
  /** The unit whose checkpoint is needed. */
  after: SeedUnitName;
  checkpoint: SeedCheckpoint | undefined;
  target: string;
  scale: SeedScaleName;
  seed: number;
  /** The database's fingerprint now. */
  fingerprint: DbFingerprint;
}

/**
 * Why a resume may not go ahead, empty when the checkpoint matches this database. Pure. These
 * replace the zero-users rule: only a database whose users are exactly the checkpoint's (so one
 * this seed wrote, restored to that point) may be resumed.
 */
export function resumeRefusals(i: ResumeInput): string[] {
  const c = i.checkpoint;
  if (!c) return [`no checkpoint after seed-${i.after} (${checkpointFileName(i.after)}); run without --from`];
  const out: string[] = [];
  if (c.unit !== i.after) out.push(`the checkpoint is after seed-${c.unit}, not seed-${i.after}`);
  if (c.target !== i.target) out.push(`the checkpoint is for ${c.target}, not ${i.target}`);
  if (c.scale !== i.scale || c.seed !== i.seed)
    out.push(`the checkpoint is for --scale ${c.scale} --seed ${c.seed}; pass the same to resume`);
  if (c.fingerprint.users !== i.fingerprint.users || c.fingerprint.usersHash !== i.fingerprint.usersHash)
    out.push(
      `the database's users (${i.fingerprint.users}) are not the checkpoint's (${c.fingerprint.users}); restore the snapshot taken after seed-${i.after} first`,
    );
  return out;
}
