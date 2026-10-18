// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Adds (or re-adds) shadcn/ui components with the pinned CLI, then applies the
 * house conventions the CLI cannot express in components.json:
 *
 *   - `cn` comes from our own `@commonair/ui/lib/utils` (clsx + tailwind-merge),
 *     not the `cn` npm package the registry now references;
 *   - every file carries an SPDX header crediting shadcn (MIT) and CommonAir;
 *   - dependencies the CLI adds with caret ranges must be pinned by hand; the
 *     ones we deliberately replace (`cn`, `next-themes`) are removed again.
 *
 *   bun scripts/shadcn-add.ts dialog sheet           # add new components
 *   bun scripts/shadcn-add.ts dialog --overwrite     # upgrade in place (review the diff!)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SHADCN_VERSION = "4.22.1";
const root = join(import.meta.dirname, "..");
const componentsDir = join(root, "src", "components");

/** Registry dependencies we replace with house code (see README). */
export const REPLACED_DEPENDENCIES = ["cn", "next-themes", "cmdk", "shadcn"];

// REUSE-IgnoreStart
export const HEADER = [
  "// SPDX-FileCopyrightText: 2023 shadcn (https://ui.shadcn.com, MIT)",
  "// SPDX-FileCopyrightText: 2026 CommonAir contributors",
  "// SPDX-License-Identifier: AGPL-3.0-or-later",
  "",
].join("\n");
// REUSE-IgnoreEnd

/** Rewrites one CLI-generated source file to the house conventions. Pure, so it is unit-tested. */
export function normalizeComponentSource(source: string): string {
  let out = source.replace(/from\s+["']cn["']/g, 'from "@commonair/ui/lib/utils"');
  if (!out.includes("SPDX-License-Identifier")) out = `${HEADER}\n${out}`;
  return out;
}

/** Removes replaced dependencies and reports unpinned ones. */
export function normalizePackageJson(pkg: { dependencies?: Record<string, string> }): string[] {
  const unpinned: string[] = [];
  const deps = pkg.dependencies ?? {};
  for (const name of REPLACED_DEPENDENCIES) delete deps[name];
  for (const [name, range] of Object.entries(deps)) {
    if (!/^(\d|workspace:|catalog:)/.test(range)) unpinned.push(`${name}@${range}`);
  }
  return unpinned;
}

function run(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${proc.exitCode}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: bun scripts/shadcn-add.ts <component...> [--overwrite]");
    process.exit(2);
  }
  run(["bunx", `shadcn@${SHADCN_VERSION}`, "add", ...args, "--yes"]);

  for (const file of readdirSync(componentsDir)) {
    if (!file.endsWith(".tsx")) continue;
    const path = join(componentsDir, file);
    const before = readFileSync(path, "utf8");
    const after = normalizeComponentSource(before);
    if (after !== before) writeFileSync(path, after);
  }

  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  const unpinned = normalizePackageJson(pkg);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  run(["vp", "fmt", "src/components", "package.json"]);
  if (unpinned.length > 0) {
    console.error(`pin these dependencies to exact versions (and check their licenses): ${unpinned.join(", ")}`);
    process.exit(1);
  }
}
