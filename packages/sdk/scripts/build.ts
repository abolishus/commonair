// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build the publishable package into `dist/` (ADR 0027 §5, ADR 0035): `vp pack` (tsdown) bundles
 * `src/index.ts` as ESM with one bundled `index.d.ts`, inlining `@commonair/contracts` (private,
 * never published; see `stage`) and keeping `@orpc/*` and `zod` as dependencies. Then
 * `dist/package.json` is written from `package.json` with exact dependency versions, and the README
 * and the Apache-2.0 licence text are copied. Every contract file the bundle inlines must allow
 * Apache-2.0 in its SPDX header (dual-licensed, ADR 0035), or the build fails; only a local or
 * dry-run build may pass `--allow-unlicensed-inline` to skip that.
 *
 *   bun run build [-- --out-dir <dir>] [--allow-unlicensed-inline]
 */
import { copyFile, cp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "vite-plus/pack";
// Relative on purpose: `@commonair/config` is not a dependency of the SDK (nothing of it ships).
import { SITE } from "../../config/src/site.ts";

const PKG_DIR = path.resolve(import.meta.dirname, "..");
const ROOT = path.resolve(PKG_DIR, "../..");
const CONTRACTS_SRC = path.join(ROOT, "packages/contracts/src") + path.sep;

/** Dependencies the bundle keeps external (everything else is inlined). */
export const EXTERNAL = [/^@orpc\//, /^zod(\/|$)/];

interface PackageJson {
  name: string;
  version: string;
  license: string;
  type: string;
  description?: string;
  dependencies: Record<string, string>;
}

export interface BuildResult {
  outDir: string;
  /** Repository-relative contract files inlined into `index.js` (code). */
  inlinedCode: string[];
  /** Repository-relative contract files inlined into `index.d.ts` (types). */
  inlinedTypes: string[];
}

/** The exact version a `catalog:` (or exact) specifier resolves to, from the root catalog. */
export function exactVersion(name: string, spec: string, catalog: Record<string, string>): string {
  const v = spec === "catalog:" || spec === "catalog:default" ? catalog[name] : spec;
  if (v === undefined) throw new Error(`${name}: not in the root catalog`);
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) throw new Error(`${name}: "${v}" is not an exact version`);
  return v;
}

/** `dist/package.json`: what npm publishes. No `private`, no workspace or catalog protocols. */
export function distPackageJson(pkg: PackageJson, catalog: Record<string, string>): Record<string, unknown> {
  const dependencies: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (name.startsWith("@commonair/")) continue; // inlined
    dependencies[name] = exactVersion(name, spec, catalog);
  }
  return {
    name: pkg.name,
    version: pkg.version,
    description:
      pkg.description ?? `TypeScript SDK for ${SITE.name}: API client, OAuth, EventSub WebSocket and webhooks, chat`,
    license: "Apache-2.0",
    type: pkg.type,
    exports: { ".": { types: "./index.d.ts", import: "./index.js" }, "./package.json": "./package.json" },
    types: "./index.d.ts",
    files: ["index.js", "index.d.ts", "README.md", "LICENSE"],
    sideEffects: false,
    engines: { node: ">=22" },
    dependencies,
    repository: { type: "git", url: `git+${SITE.repository.url}.git`, directory: "packages/sdk" },
    homepage: `${SITE.repository.url}/tree/main/packages/sdk#readme`,
    bugs: { url: `${SITE.repository.url}/issues` },
    publishConfig: { access: "public", provenance: true },
  };
}

const posix = (p: string) => p.split(path.sep).join("/");
const rel = (abs: string) => posix(path.relative(ROOT, abs));

/** `@commonair/contracts[/sub]` → the file its `exports` map names, relative to the contracts `src/`. */
export function contractTarget(specifier: string, exportsMap: Record<string, string>): string {
  const sub = specifier === "@commonair/contracts" ? "." : `./${specifier.slice("@commonair/contracts/".length)}`;
  const target = exportsMap[sub];
  if (!target?.startsWith("./src/")) throw new Error(`${specifier}: not exported from @commonair/contracts src/`);
  return target.slice("./src/".length);
}

const CONTRACT_IMPORT = /(from\s+")(@commonair\/contracts(?:\/[\w-]+)?)(")/g;

/** Rewrite the contract imports of one source file to relative paths into `contractsDir`. */
export function rewriteContractImports(
  code: string,
  fromDir: string,
  contractsDir: string,
  exportsMap: Record<string, string>,
) {
  const prefix = posix(path.relative(fromDir, contractsDir)) || ".";
  return code.replace(
    CONTRACT_IMPORT,
    (_m, a: string, spec: string, b: string) => `${a}${prefix}/${contractTarget(spec, exportsMap)}${b}`,
  );
}

/**
 * Copy the SDK and the contract sources side by side under one directory, with the contract
 * imports rewritten to relative paths. The declaration generator (tsgo, via rolldown-plugin-dts)
 * only emits files below its tsconfig's directory, so the contracts must sit below it to be
 * inlined into `index.d.ts`. The stage lives in `.cache/` (git-ignored) inside this package, so
 * `zod` and `@orpc/*` still resolve from `packages/sdk/node_modules`.
 */
async function stage(dir: string): Promise<void> {
  const contractsPkg = JSON.parse(await readFile(path.join(ROOT, "packages/contracts/package.json"), "utf8")) as {
    exports: Record<string, string>;
  };
  const contractsDir = path.join(dir, "contracts");
  await cp(CONTRACTS_SRC, contractsDir, { recursive: true });
  for (const file of await readdir(path.join(PKG_DIR, "src"), { recursive: true })) {
    if (!file.endsWith(".ts")) continue;
    const to = path.join(dir, "src", file);
    const code = rewriteContractImports(
      await readFile(path.join(PKG_DIR, "src", file), "utf8"),
      path.dirname(to),
      contractsDir,
      contractsPkg.exports,
    );
    if (/["']@commonair\//.test(code)) throw new Error(`${file}: an @commonair import the stage cannot rewrite`);
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, code);
  }
  await writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: posix(path.relative(dir, path.join(ROOT, "tsconfig.base.json"))),
      compilerOptions: { lib: ["es2024", "dom"], types: [] },
      include: ["src", "contracts"],
    }),
  );
}

const SPDX_LINE = /SPDX-License-Identifier:\s*(.+?)\s*(?:\*\/)?$/m;

/** The inlined files whose SPDX header does not allow Apache-2.0 (missing headers count as not). */
export function filesNotAllowingApache(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, text]) => !/(^|[\s(])Apache-2\.0([\s)]|$)/.test(SPDX_LINE.exec(text)?.[1] ?? ""))
    .map(([f]) => f)
    .sort();
}

/** Throw unless every inlined contract file may ship under Apache-2.0 (ADR 0035). */
export async function assertInlinedLicenses(files: string[]): Promise<void> {
  const texts: Record<string, string> = {};
  for (const f of files) texts[f] = await readFile(path.join(ROOT, f), "utf8");
  const bad = filesNotAllowingApache(texts);
  if (bad.length > 0)
    throw new Error(
      `inlined contract files do not allow Apache-2.0 (ADR 0035 needs "AGPL-3.0-or-later OR Apache-2.0"): ${bad.join(", ")}`,
    );
}

export async function buildSdk(
  opts: { outDir?: string; quiet?: boolean; allowUnlicensedInline?: boolean } = {},
): Promise<BuildResult> {
  const outDir = path.resolve(opts.outDir ?? path.join(PKG_DIR, "dist"));
  const stageDir = path.join(PKG_DIR, ".cache", `build-${process.pid}-${Date.now()}`);
  const stagedContracts = path.join(stageDir, "contracts") + path.sep;
  await rm(outDir, { recursive: true, force: true });
  const code = new Set<string>();
  const types = new Set<string>();
  try {
    await stage(stageDir);
    const handle = await build({
      config: false,
      cwd: stageDir,
      entry: { index: "src/index.ts" },
      outDir,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      tsconfig: path.join(stageDir, "tsconfig.json"),
      dts: true,
      clean: false,
      fixedExtension: false,
      hash: false,
      report: false,
      logLevel: opts.quiet ? "error" : "info",
      deps: { neverBundle: EXTERNAL, onlyBundle: false, dts: { neverBundle: EXTERNAL } },
    });
    for (const bundle of handle.bundles) {
      for (const chunk of bundle.chunks) {
        if (chunk.type !== "chunk") continue;
        const into = chunk.fileName.endsWith(".d.ts") ? types : code;
        for (const id of chunk.moduleIds) {
          const file = id.replace(/\?.*$/, "").replace(/\.d\.ts$/, ".ts");
          if (file.startsWith(stagedContracts))
            into.add(rel(path.join(CONTRACTS_SRC, file.slice(stagedContracts.length))));
        }
      }
      await bundle[Symbol.asyncDispose]();
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
    // Only when empty: another build may be staging beside this one.
    await rmdir(path.dirname(stageDir)).catch(() => undefined);
  }

  if (!opts.allowUnlicensedInline) {
    try {
      await assertInlinedLicenses([...new Set([...code, ...types])]);
    } catch (err) {
      await rm(outDir, { recursive: true, force: true });
      throw err;
    }
  }

  const pkg = JSON.parse(await readFile(path.join(PKG_DIR, "package.json"), "utf8")) as PackageJson;
  const root = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
    catalog: Record<string, string>;
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "package.json"),
    `${JSON.stringify(distPackageJson(pkg, root.catalog), null, 2)}\n`,
  );
  await copyFile(path.join(PKG_DIR, "README.md"), path.join(outDir, "README.md"));
  await copyFile(path.join(ROOT, "LICENSES/Apache-2.0.txt"), path.join(outDir, "LICENSE"));
  return { outDir, inlinedCode: [...code].sort(), inlinedTypes: [...types].sort() };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--out-dir");
  const allowUnlicensedInline = process.argv.includes("--allow-unlicensed-inline");
  if (allowUnlicensedInline) console.warn("--allow-unlicensed-inline: not publishable (local or dry-run build only)");
  const result = await buildSdk({ outDir: i > 0 ? process.argv[i + 1] : undefined, allowUnlicensedInline });
  console.warn(`built ${rel(result.outDir)}`);
  console.warn(`inlined contract files (code): ${result.inlinedCode.join(", ")}`);
  console.warn(`inlined contract files (types): ${result.inlinedTypes.join(", ")}`);
}
