// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The SDK's licence boundary (ADR 0035): what `scripts/check-licenses.ts` cannot see. Headers on
 * every file of the package, runtime dependencies (and theirs) allowlisted and permissive, and the
 * contract files the bundle inlines offered under Apache-2.0.
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { ALLOWED } from "../../../scripts/licenses.ts";
import { INLINED_CONTRACT_FILES } from "./inlined.ts";

const PKG_DIR = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG_DIR, "../..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".cache"]);
// Built from parts so REUSE does not read them as this file's own licence tags.
const COPYRIGHT_TAG = ["SPDX", "FileCopyrightText"].join("-");
const LICENSE_TAG = ["SPDX", "License", "Identifier"].join("-");

/** Licences an Apache-2.0 bundle can depend on without copyleft obligations. */
const PERMISSIVE = new Set([
  "MIT",
  "MIT-0",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "ISC",
  "Unlicense",
  "BlueOak-1.0.0",
  "Zlib",
  "Python-2.0",
  "BSL-1.0",
  "PostgreSQL",
]);

interface Manifest {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
}

const readJson = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : files(path.join(dir, e.name));
    return [path.join(dir, e.name)];
  });
}

/** The installed directory of `name` as seen from `fromDir` (Node resolution, following symlinks). */
function packageDir(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(path.dirname(candidate));
    if (path.dirname(dir) === dir) throw new Error(`${name} is not installed (from ${fromDir})`);
  }
}

/** Every runtime dependency, transitively, with its declared licence. */
function runtimeDependencies(): Map<string, string> {
  const pkg = readJson<Manifest>(path.join(PKG_DIR, "package.json"));
  const seen = new Map<string, string>();
  const queue = Object.keys(pkg.dependencies ?? {})
    .filter((n) => !n.startsWith("@commonair/"))
    .map((name) => ({ name, from: PKG_DIR }));
  for (let next = queue.shift(); next; next = queue.shift()) {
    const dir = packageDir(next.name, next.from);
    const m = readJson<Manifest>(path.join(dir, "package.json"));
    const key = `${m.name}@${m.version}`;
    if (seen.has(key)) continue;
    seen.set(key, m.license ?? "UNKNOWN");
    for (const dep of Object.keys(m.dependencies ?? {})) queue.push({ name: dep, from: dir });
  }
  return seen;
}

/** Each alternative of an SPDX `A OR B` expression (parentheses dropped). */
const alternatives = (expr: string) =>
  expr
    .replace(/[()]/g, "")
    .split(/\s+OR\s+/)
    .map((s) => s.trim());

describe("SDK licence (ADR 0035)", () => {
  test("package.json declares Apache-2.0", () => {
    expect(readJson<Manifest>(path.join(PKG_DIR, "package.json")).license).toBe("Apache-2.0");
  });

  test("every non-JSON file under packages/sdk has an Apache-2.0 SPDX header", () => {
    const checked = files(PKG_DIR).filter((f) => !f.endsWith(".json"));
    expect(checked.length).toBeGreaterThan(10);
    const missing = checked.filter((f) => {
      const head = readFileSync(f, "utf8").split("\n").slice(0, 6).join("\n");
      return !(
        head.includes(`${COPYRIGHT_TAG}: 2026 CommonAir contributors`) &&
        new RegExp(`${LICENSE_TAG}: Apache-2\\.0\\s*$`, "m").test(head)
      );
    });
    expect(missing.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  test("the README's header is an HTML comment (it ships in the tarball)", () => {
    const readme = readFileSync(path.join(PKG_DIR, "README.md"), "utf8");
    expect(
      readme.startsWith(`<!--\n${COPYRIGHT_TAG}: 2026 CommonAir contributors\n${LICENSE_TAG}: Apache-2.0\n-->\n`),
    ).toBe(true);
  });

  test("every runtime dependency (transitively) is allowlisted and compatible with Apache-2.0", () => {
    const deps = runtimeDependencies();
    expect([...deps.keys()].some((k) => k.startsWith("zod@"))).toBe(true);
    const bad = [...deps].filter(([, license]) => {
      const ok = alternatives(license).filter((l) => ALLOWED.has(l) && PERMISSIVE.has(l));
      return ok.length === 0;
    });
    expect(bad).toEqual([]);
  });

  test("the inlined contract files exist", () => {
    for (const f of INLINED_CONTRACT_FILES) expect(existsSync(path.join(ROOT, f))).toBe(true);
  });

  // Until the orchestrator applies the dual-licence request (ADR 0035; the maintainer confirms it
  // before the first publish), these files are AGPL-3.0-or-later only. Then this becomes:
  //   every INLINED_CONTRACT_FILES header carries the dual licence (AGPL-3.0-or-later or Apache-2.0).
  // oxlint-disable-next-line vitest/warn-todo -- pending the maintainer's dual-licence confirmation (ADR 0035)
  test.todo("every inlined contract file's header allows Apache-2.0 (AGPL-3.0-or-later OR Apache-2.0)");
});
