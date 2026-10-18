// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Scenario registry. Scenarios are discovered from `harness/scenarios/*.ts` (files starting with
 * `_` are helpers, not scenarios), so later units add a scenario by adding one file and never
 * edit a shared index. `full` is not a file: it expands to every scenario with `inFull !== false`.
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEEDS, type Scenario } from "./scenario.ts";

export const SCENARIOS_DIR = fileURLToPath(new URL("../scenarios", import.meta.url));
export const FULL = "full";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
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
  return s as Scenario;
}

export class Registry {
  private readonly byName = new Map<string, Scenario>();

  constructor(scenarios: readonly Scenario[]) {
    for (const s of scenarios) {
      if (this.byName.has(s.name)) throw new RegistryError(`duplicate scenario "${s.name}"`);
      this.byName.set(s.name, s);
    }
  }

  get all(): Scenario[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Scenario | undefined {
    return this.byName.get(name);
  }

  /** Scenarios `full` runs, in a stable order (smoke first: it validates the basics). */
  get full(): Scenario[] {
    const list = this.all.filter((s) => s.inFull !== false);
    return [...list.filter((s) => s.name === "smoke"), ...list.filter((s) => s.name !== "smoke")];
  }

  /** Expand `full`, dedupe keeping first occurrence, and reject unknown names. */
  resolve(names: readonly string[]): Scenario[] {
    if (names.length === 0) throw new RegistryError("no scenario given (try `list`)");
    const out: Scenario[] = [];
    const seen = new Set<string>();
    const unknown: string[] = [];
    for (const name of names) {
      const expanded = name === FULL ? this.full : [this.byName.get(name)];
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

/** Import every scenario module in `dir`. */
export async function loadRegistry(dir = SCENARIOS_DIR): Promise<Registry> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .sort();
  const scenarios: Scenario[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
    scenarios.push(validateScenario(mod.default, file));
  }
  return new Registry(scenarios);
}
