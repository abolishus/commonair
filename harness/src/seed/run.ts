// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `seed full` and `seed live`: the guard, then every unit in dependency order. */
import { loadEnv, seedEnv } from "@commonair/config";
import { createDb } from "@commonair/db";
import { generatePassword, passwordProblem } from "@commonair/db/demo";
import type { Logger } from "@commonair/observability";
import type { HarnessEnv } from "../env.ts";
import { pendingTables } from "./coverage.ts";
import { fullSeedRefusals } from "./guard.ts";
import { createRng } from "./prng.ts";
import { SEED_SCALES, type SeedScaleName } from "./scale.ts";
import type { SeedStore, SeedUnitReport } from "./types.ts";
import { SEED_UNITS, orderUnits } from "./units.ts";

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
  const handle = url ? createDb({ url, max: 4, applicationName: "commonair-seed" }) : undefined;
  try {
    const userCount = handle
      ? Number((await handle.sql<{ n: number }[]>`select count(*)::int as n from users`)[0]?.n ?? 0)
      : 0;
    const refusals = fullSeedRefusals({ seedFull: DEMO_SEED_FULL, databaseUrl: url, confirm: o.confirm, userCount });
    if (refusals.length > 0 || !handle) {
      for (const r of refusals) out(`refused: ${r}`);
      return 2;
    }
    const password = given || generatePassword();
    const root = createRng(o.seed);
    const store: SeedStore = { users: [], channels: [], extra: {} };
    const now = new Date();
    const reports: { unit: string; report: SeedUnitReport }[] = [];
    for (const unit of orderUnits(SEED_UNITS)) {
      if (o.signal.aborted) throw o.signal.reason;
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
      out(`seed-${unit.name}: ${rows} rows in ${((Date.now() - started) / 1000).toFixed(1)} s`);
      for (const n of report.notes ?? []) out(`  note: ${n}`);
    }
    const pending = pendingTables(SEED_UNITS);
    if (Object.keys(pending).length > 0) {
      out("Not seeded yet:");
      for (const [unit, tables] of Object.entries(pending)) out(`  seed-${unit}: ${tables.join(", ")}`);
    }
    out(given ? "Password: the value of DEMO_SEED_PASSWORD" : `Password for every account: ${password}`);
    return 0;
  } finally {
    await handle?.close();
  }
}

export interface SeedLiveOptions {
  channels: number;
  durationMs?: number;
  out?: (line: string) => void;
}

/** `seed live`: seed-media implements it (unit 7). */
export async function runSeedLive(o: SeedLiveOptions): Promise<number> {
  (o.out ?? ((l: string) => console.log(l)))("seed live: not implemented yet (seed-media)");
  return 1;
}
