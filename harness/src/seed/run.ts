// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `seed full` and `seed live`: the guard, then every unit in dependency order. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadEnv, seedEnv } from "@commonair/config";
import { type DbHandle, createDb } from "@commonair/db";
import { generatePassword, passwordProblem } from "@commonair/db/demo";
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "../env.ts";
import {
  type DbFingerprint,
  type SeedCheckpoint,
  CHECKPOINT_VERSION,
  clearCheckpoints,
  readCheckpoint,
  resumeRefusals,
  selectUnits,
  writeCheckpoint,
} from "./checkpoint.ts";
import { stopSeedProxy } from "./clients.ts";
import { pendingTables } from "./coverage.ts";
import { describeTarget, fullSeedRefusals } from "./guard.ts";
import { createRng } from "./prng.ts";
import { SEED_SCALES, type SeedScaleName } from "./scale.ts";
import type { SeedStore, SeedUnit, SeedUnitName, SeedUnitReport } from "./types.ts";
import { SEED_UNITS, orderUnits, runUnits } from "./units.ts";

export interface SeedFullOptions {
  scale: SeedScaleName;
  seed: number;
  confirm?: string;
  env: HarnessEnv;
  log: Logger;
  signal: AbortSignal;
  out?: (line: string) => void;
  /** Defaults to process.env (DEMO_SEED_FULL, DEMO_SEED_PASSWORD). */
  source?: Record<string, string | undefined>;
  /**
   * Where to write the store once every unit ran (`SeedStoreFile`): the `seed-coverage` scenario
   * reads it to sign in and fill route params after a separate `seed full`.
   */
  storeFile?: string;
  /** Receives the store once every unit ran (the scenario's own seed). */
  onStore?: (store: SeedStore) => void;
  /**
   * Where checkpoints go (one after each unit) and `from` reads them. Unset: none are written, and
   * `from` is refused.
   */
  checkpointDir?: string;
  /** Resume: run from this unit, on a database restored to the checkpoint after the unit before it. */
  from?: SeedUnitName;
  /** Stop after this unit (`selfhost.sh` runs one unit at a time and snapshots in between). */
  to?: SeedUnitName;
  /**
   * Run each unit as soon as the units it waits for are done, beside the others (`runUnits`).
   * Ignored when checkpoints are written: a checkpoint after one unit must not hold half of another.
   */
  concurrent?: boolean;
  /** Each unit's wall time and rows once it is done (the scenario's per-unit metrics). */
  onUnit?: (unit: SeedUnitName, ms: number, rows: number) => void;
}

/** The store file's name in the harness report directory. */
export const SEED_STORE_FILE = "seed-store.json";

/** What `storeFile` holds. No password: sign in with DEMO_SEED_PASSWORD. */
export interface SeedStoreFile {
  scale: SeedScaleName;
  seed: number;
  seededAt: string;
  store: SeedStore;
}

/** Exit code: 0 seeded, 1 a unit failed, 2 refused. */
export async function runSeedFull(o: SeedFullOptions): Promise<number> {
  const out = o.out ?? ((l: string) => console.log(l));
  const source = o.source ?? process.env;
  const { DEMO_SEED_FULL } = loadEnv(seedEnv, source);
  const given = source.DEMO_SEED_PASSWORD;
  const problem = given ? passwordProblem(given) : null;
  if (problem) {
    out(`refused: DEMO_SEED_PASSWORD ${problem}`);
    return 2;
  }
  const url = o.env.DATABASE_URL;
  const handle = url ? createDb({ url, max: 6, applicationName: "commonair-seed" }) : undefined;
  try {
    const selection = selectUnits(orderUnits(SEED_UNITS), o.from, o.to);
    const fingerprint = handle ? await dbFingerprint(handle) : { users: 0, usersHash: "" };
    let checkpoint: SeedCheckpoint | undefined;
    let resume: string[] | undefined;
    if (selection.resumeAfter && url) {
      const after = selection.resumeAfter;
      if (!o.checkpointDir) resume = ["this run has no report directory to read checkpoints from"];
      else {
        try {
          checkpoint = readCheckpoint(o.checkpointDir, after);
          resume = resumeRefusals({
            after,
            checkpoint,
            target: describeTarget(url),
            scale: o.scale,
            seed: o.seed,
            fingerprint,
          });
        } catch (err) {
          resume = [(err as Error).message];
        }
      }
      // seed-social set every account's password; a made-up one would sign nobody in.
      if (!given) resume.push("DEMO_SEED_PASSWORD is not set; a resume needs the password the run started with");
    }
    const refusals = fullSeedRefusals({
      seedFull: DEMO_SEED_FULL,
      databaseUrl: url,
      confirm: o.confirm,
      userCount: fingerprint.users,
      ...(resume ? { resume } : {}),
    });
    if (refusals.length > 0 || !handle || !url) {
      for (const r of refusals) out(`refused: ${r}`);
      return 2;
    }
    const password = given || generatePassword();
    const root = createRng(o.seed);
    const store: SeedStore = checkpoint?.store ?? { users: [], channels: [], extra: {} };
    const now = checkpoint ? new Date(checkpoint.now) : new Date();
    if (checkpoint) out(`resuming after seed-${checkpoint.unit} (checkpoint of ${checkpoint.now})`);
    else if (o.checkpointDir) clearCheckpoints(o.checkpointDir);
    const reports: { unit: string; report: SeedUnitReport }[] = [];
    const concurrent = (o.concurrent ?? false) && !o.checkpointDir;
    if (concurrent) out("units run side by side as their dependencies allow");
    const runOne = async (unit: SeedUnit) => {
      const started = Date.now();
      out(`seed-${unit.name}: running`);
      const report = await unit.run({
        db: handle,
        env: o.env,
        rng: root.fork(unit.name),
        scale: SEED_SCALES[o.scale],
        scaleName: o.scale,
        password,
        now,
        store,
        log: o.log.child({ seedUnit: unit.name }),
        signal: o.signal,
      });
      reports.push({ unit: unit.name, report });
      const rows = Object.values(report.rows).reduce((a, b) => a + b, 0);
      const ms = Date.now() - started;
      out(`seed-${unit.name}: ${rows} rows in ${(ms / 1000).toFixed(1)} s`);
      o.onUnit?.(unit.name, ms, rows);
      for (const n of report.notes ?? []) out(`  note: ${n}`);
      if (o.checkpointDir) {
        const file = writeCheckpoint(o.checkpointDir, {
          version: CHECKPOINT_VERSION,
          unit: unit.name,
          target: describeTarget(url),
          scale: o.scale,
          seed: o.seed,
          now: now.toISOString(),
          fingerprint: await dbFingerprint(handle),
          store,
        });
        out(`  checkpoint: ${file}`);
      }
    };
    await runUnits(selection.run, runOne, { concurrent, signal: o.signal });
    const passwordLine = given
      ? "Password: the value of DEMO_SEED_PASSWORD"
      : `Password for every account: ${password}`;
    if (!selection.reachesEnd) {
      out(`stopped after seed-${selection.run.at(-1)?.name ?? "?"} (--to)`);
      out(passwordLine);
      return 0;
    }
    o.onStore?.(store);
    if (o.storeFile) {
      const file: SeedStoreFile = { scale: o.scale, seed: o.seed, seededAt: now.toISOString(), store };
      mkdirSync(dirname(o.storeFile), { recursive: true });
      writeFileSync(o.storeFile, `${JSON.stringify(file, null, 2)}\n`);
      out(`Store written to ${o.storeFile}`);
    }
    const pending = pendingTables(SEED_UNITS);
    if (Object.keys(pending).length > 0) {
      out("Not seeded yet:");
      for (const [unit, tables] of Object.entries(pending)) out(`  seed-${unit}: ${tables.join(", ")}`);
    }
    out(passwordLine);
    return 0;
  } finally {
    await stopSeedProxy();
    await handle?.close();
  }
}

/** Count and hash of every user id: what ties a checkpoint to its database. */
export async function dbFingerprint(handle: DbHandle): Promise<DbFingerprint> {
  const [row] = await handle.sql<{ n: number; h: string }[]>`
    select count(*)::int as n, md5(coalesce(string_agg(id::text, ',' order by id), '')) as h from users`;
  return { users: row?.n ?? 0, usersHash: row?.h ?? "" };
}

export interface SeedLiveOptions {
  channels: number;
  durationMs?: number;
  out?: (line: string) => void;
}

/** `seed live`: seed-media implements it (unit 7). */
export async function runSeedLive(o: SeedLiveOptions): Promise<number> {
  // Loaded on demand: `seed full` never needs the live publishers, chat clients or browser fleet.
  const { runSeedLiveCommand } = await import("./media/live-io.ts");
  return runSeedLiveCommand(o);
}
