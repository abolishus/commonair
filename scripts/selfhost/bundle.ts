// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Builds the self-host bundle (ADR 0023 §7), the CLI contract the release workflow and the
 * end-to-end test both call:
 *
 *   bun scripts/selfhost/bundle.ts --manifest <release-manifest.json> --out <dir> [--registry <r>]
 *
 * writes `<dir>/commonair-selfhost_<version>.tar.gz` and prints its path. No network, no podman.
 *
 * Layout, under `commonair-selfhost_<version>/` (selfhost.sh extracts that to
 * ~/.local/share/commonair/releases/<version>, and ~/commonair links to it):
 *   selfhost.sh, release-manifest.json, release.env (the manifest's facts for the shell),
 *   quadlet/ (rendered), systemd/, every config file the units mount from %h/commonair/ and
 *   every file their ExecStartPre= and ExecStopPost= lines use from there (the env renderer, key
 *   lists and cgroup reset),
 *   tools/ (init-env and fetch-model bundled into single files, run with the tools image's Bun,
 *   plus .env.example and the licenses of the npm packages bundled into them), LICENSES/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SITE } from "../../packages/config/src/site.ts";
import { bundleAssetName, parseManifest, type ReleaseManifest } from "../release/manifest.ts";
import { renderUnits } from "./render.ts";
import { gzipReproducible, tar, type TarEntry } from "./tar.ts";
import { QUADLET_DIR, SYSTEMD_DIR, readUnitDir, releaseExecFiles, releaseMounts } from "./units.ts";

export const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/** Bun scripts the host runs inside the tools image, bundled so the image needs only Bun. */
export const TOOL_SCRIPTS = { "init-env.js": "scripts/init-env.ts", "fetch-model.js": "scripts/fetch-model.ts" };

/** Licenses the bundle's own files carry (scripts, units, config, docs). */
const LICENSE_FILES = ["LICENSES/AGPL-3.0-or-later.txt", "LICENSES/CC0-1.0.txt", "LICENSES/CC-BY-SA-4.0.txt"];

const enc = new TextEncoder();
const FILE = 0o644;
const EXEC = 0o755;

export const bundleTopDir = (version: string) => `commonair-selfhost_${version}`;

/** Facts the shell needs without a JSON parser. */
export function releaseEnv(m: ReleaseManifest, registry: string): string {
  return [
    `COMMONAIR_VERSION=${m.version}`,
    `COMMONAIR_TAG=${m.tag}`,
    `COMMONAIR_COMMIT=${m.commit}`,
    `COMMONAIR_REGISTRY=${registry}`,
    `COMMONAIR_REPOSITORY_URL=${SITE.repository.url}`,
    "",
  ].join("\n");
}

/** Files (recursively, for a directory) under a repository path, as repository paths. */
function filesUnder(root: string, path: string): string[] {
  const abs = join(root, path);
  if (!existsSync(abs)) throw new Error(`a unit mounts ${path}, which does not exist in the repository`);
  if (!statSync(abs).isDirectory()) return [path];
  return readdirSync(abs)
    .sort()
    .flatMap((f) => filesUnder(root, `${path}/${f}`));
}

/** Bundles one script into a single ESM file for Bun; returns it and the npm packages inside. */
export async function bundleTool(root: string, entry: string): Promise<{ code: Uint8Array; packages: string[] }> {
  const result = await Bun.build({ entrypoints: [join(root, entry)], target: "bun", format: "esm", root });
  const [output] = result.outputs;
  if (!result.success || !output)
    throw new Error(`bundling ${entry} failed: ${result.logs.map((l) => l.message).join("\n")}`);
  // Bun marks each module with a `// <path>` comment relative to the working directory; make
  // them relative to the repository so the bytes do not depend on where this runs.
  const code = (await output.text()).replace(
    /^\/\/ ((?:\.\.\/)*[\w@.+/-]+\.(?:[cm]?[jt]sx?|json))$/gm,
    (_line, p: string) => `// ${relative(root, resolve(process.cwd(), p))}`,
  );
  // Package directories end at node_modules/<name>.
  const packages = new Set<string>();
  for (const m of code.matchAll(/^\/\/ (\S*node_modules\/(?:@[^/]+\/)?[^/]+)\//gm)) {
    if (m[1]) packages.add(m[1]);
  }
  return { code: enc.encode(code), packages: [...packages].sort() };
}

function licenseOf(root: string, pkgDir: string): { name: string; text: string } {
  const abs = join(root, pkgDir);
  const manifest = JSON.parse(readFileSync(join(abs, "package.json"), "utf8")) as { name: string; version: string };
  const file = readdirSync(abs)
    .sort()
    .find((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (!file) throw new Error(`${manifest.name} ships no LICENSE file; it cannot be bundled`);
  return { name: `${manifest.name}@${manifest.version}`, text: readFileSync(join(abs, file), "utf8") };
}

export interface BundleOptions {
  root?: string;
  manifestJson: string;
  registry?: string;
}

/** Every entry of the bundle, paths relative to the archive root. */
export async function bundleEntries(opts: BundleOptions): Promise<{ version: string; entries: TarEntry[] }> {
  const root = opts.root ?? REPO_ROOT;
  const manifest = parseManifest(opts.manifestJson);
  const registry = opts.registry ?? manifest.registry;
  const top = bundleTopDir(manifest.version);
  const entries: TarEntry[] = [];
  const add = (path: string, data: Uint8Array | string, mode = FILE) =>
    entries.push({ path: `${top}/${path}`, data: typeof data === "string" ? enc.encode(data) : data, mode });

  add("selfhost.sh", readFileSync(join(root, "scripts/selfhost.sh")), EXEC);
  add("release-manifest.json", opts.manifestJson);
  add("release.env", releaseEnv(manifest, registry));

  const units = readUnitDir(join(root, QUADLET_DIR));
  for (const [name, text] of renderUnits(units, manifest, registry)) add(`quadlet/${name}`, text);
  for (const [name, text] of readUnitDir(join(root, SYSTEMD_DIR))) add(`systemd/${name}`, text);
  for (const path of releaseMounts(units.values()))
    for (const file of filesUnder(root, path)) add(file, readFileSync(join(root, file)));
  // What the units' ExecStartPre= and ExecStopPost= lines name: the env renderer and key lists
  // (unit-env.ts), and cgroup-reset.sh.
  for (const file of releaseExecFiles(units.values())) {
    if (!existsSync(join(root, file))) throw new Error(`a unit runs or reads ${file}, which does not exist`);
    add(file, readFileSync(join(root, file)));
  }

  const notices: string[] = [];
  for (const [name, entry] of Object.entries(TOOL_SCRIPTS)) {
    const { code, packages } = await bundleTool(root, entry);
    add(`tools/${name}`, code);
    for (const pkg of packages) {
      const { name: id, text } = licenseOf(root, pkg);
      if (!notices.some((n) => n.startsWith(`${id}\n`)))
        notices.push(`${id}\n${"=".repeat(id.length)}\n\n${text.trim()}\n`);
    }
  }
  add("tools/.env.example", readFileSync(join(root, ".env.example")));
  add(
    "tools/THIRD-PARTY-LICENSES.txt",
    `npm packages bundled into tools/*.js, with their licenses.\n\n${notices.sort().join("\n")}`,
  );
  for (const file of LICENSE_FILES) add(file, readFileSync(join(root, file)));
  return { version: manifest.version, entries };
}

/** Builds the archive; same inputs, same bytes. */
export async function buildBundle(opts: BundleOptions): Promise<{ name: string; data: Uint8Array }> {
  const { version, entries } = await bundleEntries(opts);
  return { name: bundleAssetName(version), data: gzipReproducible(tar(entries)) };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const manifestPath = arg(argv, "--manifest");
  const out = arg(argv, "--out");
  if (!manifestPath || !out) {
    console.error(
      "usage: bun scripts/selfhost/bundle.ts --manifest <release-manifest.json> --out <dir> [--registry <r>]",
    );
    process.exit(2);
  }
  try {
    const { name, data } = await buildBundle({
      manifestJson: readFileSync(manifestPath, "utf8"),
      registry: arg(argv, "--registry"),
    });
    mkdirSync(out, { recursive: true });
    const path = join(out, name);
    writeFileSync(path, data);
    console.log(path);
  } catch (e) {
    console.error(`bundle: ${(e as Error).message}`);
    process.exit(1);
  }
}
