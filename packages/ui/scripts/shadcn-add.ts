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
 *     ones we deliberately replace (`cn`, `next-themes`, `cmdk`) are removed again.
 *
 *   bun scripts/shadcn-add.ts dialog sheet           # add new components
 *   bun scripts/shadcn-add.ts dialog --overwrite     # upgrade in place (review the diff!)
 *   bun scripts/shadcn-add.ts --snapshot             # regenerate upstream/ from a scratch preset project
 *
 * `--overwrite` replaces our deliberate deviations too: re-apply every row of
 * DEVIATIONS.md afterwards (tests/deviations.test.ts fails until you do).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHADCN_VERSION = "4.21.1";
/** The preset the upstream reference project is generated from (base-lyra, zinc, inverted bold menus). */
export const SHADCN_PRESET = "b1ZhhFNpx";
const root = join(import.meta.dirname, "..");
const componentsDir = join(root, "src", "components");
const hooksDir = join(root, "src", "hooks");
export const upstreamDir = join(root, "upstream");

/** Every registry component this package carries (the `--snapshot` list). */
export const COMPONENTS = [
  "accordion",
  "alert",
  "alert-dialog",
  "aspect-ratio",
  "avatar",
  "badge",
  "breadcrumb",
  "button",
  "button-group",
  "card",
  "chart",
  "checkbox",
  "collapsible",
  "combobox",
  "command",
  "context-menu",
  "dialog",
  "drawer",
  "dropdown-menu",
  "empty",
  "field",
  "hover-card",
  "input",
  "input-group",
  "item",
  "kbd",
  "label",
  "navigation-menu",
  "pagination",
  "popover",
  "progress",
  "radio-group",
  "scroll-area",
  "select",
  "separator",
  "sheet",
  "sidebar",
  "skeleton",
  "slider",
  "sonner",
  "spinner",
  "switch",
  "table",
  "tabs",
  "textarea",
  "toggle",
  "toggle-group",
  "tooltip",
] as const;

/** Registry dependencies we replace with house code (see DEVIATIONS.md). */
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

/**
 * Maps the default `@/…` aliases of a scratch preset project onto this package's
 * `@commonair/ui/…` aliases, so its output is comparable file by file.
 */
export function rewriteProbeAliases(source: string): string {
  return source
    .replace(/(["'])@\/components\/ui\//g, "$1@commonair/ui/components/")
    .replace(/(["'])@\/hooks\//g, "$1@commonair/ui/hooks/")
    .replace(/(["'])@\/lib\//g, "$1@commonair/ui/lib/");
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

/** File name under `upstream/` for a source file: stored as text so lint and typecheck skip it. */
export function upstreamName(file: string): string {
  return `${file}.txt`;
}

function run(cmd: string[], cwd = root): void {
  const proc = Bun.spawnSync(cmd, { cwd, stdio: ["inherit", "inherit", "inherit"] });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with ${proc.exitCode}`);
}

function normalizeDir(dir: string, pattern: RegExp): void {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!pattern.test(file)) continue;
    const path = join(dir, file);
    const before = readFileSync(path, "utf8");
    const after = normalizeComponentSource(before);
    if (after !== before) writeFileSync(path, after);
  }
}

/**
 * Generates the upstream reference: a scratch Vite project from the preset (outside
 * the repository), every component in COMPONENTS added with Hugeicons, then each
 * file normalized and formatted exactly like ours and stored in `upstream/`.
 */
function snapshot(): void {
  const scratch = mkdtempSync(join(tmpdir(), "commonair-shadcn-"));
  try {
    run(
      [
        "bunx",
        `shadcn@${SHADCN_VERSION}`,
        "init",
        "-t",
        "vite",
        "-b",
        "base",
        "-p",
        SHADCN_PRESET,
        "-n",
        "probe",
      ].concat(["--no-monorepo", "-y"]),
      scratch,
    );
    const probe = join(scratch, "probe");
    const configPath = join(probe, "components.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { iconLibrary: string };
    config.iconLibrary = "hugeicons";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    run(["bunx", `shadcn@${SHADCN_VERSION}`, "add", ...COMPONENTS, "--yes", "--overwrite"], probe);

    rmSync(upstreamDir, { recursive: true, force: true });
    const groups = [
      { from: join(probe, "src", "components", "ui"), to: join(upstreamDir, "components"), pattern: /\.tsx$/ },
      { from: join(probe, "src", "hooks"), to: join(upstreamDir, "hooks"), pattern: /\.ts$/ },
    ];
    const written: string[] = [];
    for (const { from, to, pattern } of groups) {
      mkdirSync(to, { recursive: true });
      for (const file of readdirSync(from)) {
        if (!pattern.test(file)) continue;
        const source = normalizeComponentSource(rewriteProbeAliases(readFileSync(join(from, file), "utf8")));
        writeFileSync(join(to, file), source);
        written.push(join(to, file));
      }
    }
    // Format as TypeScript, then store as text.
    run(["vp", "fmt", "upstream"]);
    for (const path of written) renameSync(path, upstreamName(path));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--snapshot")) {
    snapshot();
    process.exit(0);
  }
  if (args.length === 0) {
    console.error("usage: bun scripts/shadcn-add.ts <component...> [--overwrite] | --snapshot");
    process.exit(2);
  }
  run(["bunx", `shadcn@${SHADCN_VERSION}`, "add", ...args, "--yes"]);

  normalizeDir(componentsDir, /\.tsx$/);
  normalizeDir(hooksDir, /\.ts$/);

  const pkgPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  const unpinned = normalizePackageJson(pkg);
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  run(["vp", "fmt", "src/components", "src/hooks", "package.json"]);
  if (unpinned.length > 0) {
    console.error(`pin these dependencies to exact versions (and check their licenses): ${unpinned.join(", ")}`);
    process.exit(1);
  }
}
