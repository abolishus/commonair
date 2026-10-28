// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scenario registry. Scenarios are discovered from `harness/scenarios/*.ts` (files starting with
 * `_` are helpers, not scenarios), so later units add a scenario by adding one file and never
 * edit a shared index. `full` is not a file: it expands to every scenario with `inFull !== false`,
 * `smoke` first and `e2e-relay` last, and refuses to run while a Phase 4 scenario it must
 * include (`FULL_REQUIRED`) is missing or left out. `full:<shard>` runs one part of `full`
 * (`FULL_SHARDS`), so CI can run the parts on parallel runners.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEEDS, type ParamNeed, type Scenario } from "./scenario.ts";
import { FULL_SHARDS, type FullShard } from "./shards.ts";

export { FULL_SHARDS, type FullShard };

export const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios", import.meta.url));
export const FULL = "full";

/** Runs first: it validates the basics before anything long starts. */
export const FULL_FIRST = "smoke";
/** Runs last: the longest scenario (~15 min), so a failure elsewhere surfaces early. */
export const FULL_LAST = "e2e-relay";

/**
 * Every scenario `full` must run (docs/testing/e6-selectors.md, ADR 0021): Phase 1–4 coverage.
 * A missing file or an `inFull: false` on one of these fails `full` instead of shrinking it.
 * `load-plan` is deliberately absent (20 × 200 is a manual run).
 */
export const FULL_REQUIRED = [
  "smoke",
  "ingest-rtmp",
  "ingest-whip",
  "viewers",
  "load-smoke",
  "e2e-basic",
  "e2e-social",
  "integrity-basic",
  "e4b-money",
  "trust-safety",
  "e5-coop",
  // E6 (unit E1 writes these five).
  "simulcast",
  "overlay-alert",
  "vod-clips",
  "data-export",
  "account-deletion",
  // E6 (this unit).
  "backup-restore",
  "e2e-relay",
  // S1-c: two of each app service (needs `stack --harness --multi`).
  "multi-instance",
  // E7: egress, status incidents and integrity review.
  "e7-admin",
  // W0: one media clock (ADR 0012).
  "clock-skew",
] as const;

/** `full`'s scenarios that one shard runs, in `full`'s order. Pure. */
export function shardOf(full: readonly Scenario[], shard: FullShard): Scenario[] {
  const named = new Set<string>(Object.values(FULL_SHARDS).flatMap((n) => n ?? []));
  const mine: readonly string[] | null = FULL_SHARDS[shard];
  return full.filter((s) => (mine === null ? !named.has(s.name) : mine.includes(s.name)));
}

/**
 * Parameter variants of scenarios whose module does not declare `paramNeeds` itself. The Stripe
 * variant of `e4b-money` is the one step `--profile no-proprietary` skips.
 */
export const DEFAULT_PARAM_NEEDS: Readonly<Record<string, readonly ParamNeed[]>> = {
  "e4b-money": [{ param: "provider", value: "stripe", needs: ["stripe"], step: "Stripe variant" }],
};

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function validParamNeeds(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((pn: unknown) => {
    if (typeof pn !== "object" || pn === null) return false;
    const p = pn as Partial<ParamNeed>;
    return (
      typeof p.param === "string" &&
      typeof p.value === "string" &&
      typeof p.step === "string" &&
      Array.isArray(p.needs) &&
      p.needs.every((n) => (NEEDS as readonly string[]).includes(n))
    );
  });
}

/** Validate a module's default export as a Scenario named after its file. */
export function validateScenario(value: unknown, file: string): Scenario {
  const expected = basename(file).replace(/\.ts$/, "");
  if (typeof value !== "object" || value === null) throw new RegistryError(`${file}: default export is not a scenario`);
  const s = value as Partial<Scenario>;
  if (typeof s.name !== "string" || s.name !== expected) {
    throw new RegistryError(`${file}: scenario name must equal the file name "${expected}"`);
  }
  if (s.name === FULL) throw new RegistryError(`${file}: "${FULL}" is reserved`);
  if (typeof s.description !== "string" || s.description.length === 0)
    throw new RegistryError(`${file}: missing description`);
  if (typeof s.run !== "function") throw new RegistryError(`${file}: missing run(ctx)`);
  if (!Array.isArray(s.needs) || s.needs.some((n) => !(NEEDS as readonly string[]).includes(n))) {
    throw new RegistryError(`${file}: needs must be a list of ${NEEDS.join(", ")}`);
  }
  if (!validParamNeeds(s.paramNeeds)) {
    throw new RegistryError(`${file}: paramNeeds must be a list of { param, value, needs, step }`);
  }
  return s as Scenario;
}

/** Order `full`: `FULL_FIRST` first, `FULL_LAST` last, the rest by name. Pure. */
export function orderFull(scenarios: readonly Scenario[]): Scenario[] {
  const included = scenarios.filter((s) => s.inFull !== false).sort((a, b) => a.name.localeCompare(b.name));
  const middle = included.filter((s) => s.name !== FULL_FIRST && s.name !== FULL_LAST);
  return [...included.filter((s) => s.name === FULL_FIRST), ...middle, ...included.filter((s) => s.name === FULL_LAST)];
}

/** Names `full` must include but does not (missing file or `inFull: false`). Pure. */
export function missingFromFull(scenarios: readonly Scenario[], required: readonly string[] = FULL_REQUIRED): string[] {
  const inFull = new Set(orderFull(scenarios).map((s) => s.name));
  return required.filter((n) => !inFull.has(n));
}

export class Registry {
  private readonly byName = new Map<string, Scenario>();

  constructor(
    scenarios: readonly Scenario[],
    private readonly required: readonly string[] = [],
  ) {
    for (const s of scenarios) {
      if (this.byName.has(s.name)) throw new RegistryError(`duplicate scenario "${s.name}"`);
      const paramNeeds = s.paramNeeds ?? DEFAULT_PARAM_NEEDS[s.name];
      this.byName.set(s.name, paramNeeds ? { ...s, paramNeeds } : s);
    }
  }

  get all(): Scenario[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Scenario | undefined {
    return this.byName.get(name);
  }

  /** Scenarios `full` runs, in a stable order (smoke first, e2e-relay last). */
  get full(): Scenario[] {
    return orderFull(this.all);
  }

  /** Expand `full` and `full:<shard>`, dedupe keeping first occurrence, and reject unknown names. */
  resolve(names: readonly string[]): Scenario[] {
    if (names.length === 0) throw new RegistryError("no scenario given (try `list`)");
    const shards = names.filter((n) => n.startsWith(`${FULL}:`)).map((n) => n.slice(FULL.length + 1));
    const badShard = shards.filter((sh) => !Object.hasOwn(FULL_SHARDS, sh));
    if (badShard.length > 0) {
      throw new RegistryError(
        `unknown full shard(s): ${badShard.join(", ")}. Shards: ${Object.keys(FULL_SHARDS).join(", ")}`,
      );
    }
    if (shards.length > 0) {
      // A shard named here but not in `full` would silently never run anywhere.
      const inFull = new Set(this.full.map((s) => s.name));
      const stray = Object.values(FULL_SHARDS)
        .flatMap((n) => n ?? [])
        .filter((n) => !inFull.has(n));
      if (stray.length > 0) throw new RegistryError(`full shards name scenario(s) not in full: ${stray.join(", ")}`);
    }
    if (names.includes(FULL) || shards.length > 0) {
      const missing = missingFromFull(this.all, this.required);
      if (missing.length > 0) {
        throw new RegistryError(
          `full: required scenario(s) missing or excluded (inFull: false): ${missing.join(", ")}`,
        );
      }
    }
    const out: Scenario[] = [];
    const seen = new Set<string>();
    const unknown: string[] = [];
    for (const name of names) {
      const expanded =
        name === FULL
          ? this.full
          : name.startsWith(`${FULL}:`)
            ? shardOf(this.full, name.slice(FULL.length + 1) as FullShard)
            : [this.byName.get(name)];
      for (const s of expanded) {
        if (!s) {
          unknown.push(name);
          continue;
        }
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push(s);
      }
    }
    if (unknown.length > 0) {
      throw new RegistryError(
        `unknown scenario(s): ${unknown.join(", ")}. Available: ${[FULL, ...this.all.map((s) => s.name)].join(", ")}`,
      );
    }
    return out;
  }
}

/**
 * Import every scenario module in `dir`. The shipped directory enforces `FULL_REQUIRED`; another
 * directory (tests, experiments) enforces nothing unless `required` is given.
 */
export async function loadRegistry(
  dir = SCENARIOS_DIR,
  required: readonly string[] = dir === SCENARIOS_DIR ? FULL_REQUIRED : [],
): Promise<Registry> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    scenarios.push(validateScenario(mod.default, file));
  }
  return new Registry(scenarios, required);
}
