// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Generate the typed key modules from the English catalogs.
 *
 *   bun packages/i18n/src/cli.ts gen --catalogs <dir containing en/> --out <keys dir> [--check]
 *
 * `--check` writes nothing and exits 1 listing what is stale or invalid.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCatalog, readNamespaces, renderKeyModules } from "./catalog.ts";

export interface GenResult {
  ok: boolean;
  /** Human-readable lines: problems, or what was (or would be) written. */
  lines: string[];
}

export function runGen(opts: { catalogs: string; out: string; check: boolean }): GenResult {
  const namespaces = readNamespaces(opts.catalogs);
  const problems = checkCatalog(namespaces);
  if (problems.length > 0) return { ok: false, lines: problems };
  const files = renderKeyModules(namespaces);
  const existing = existsSync(opts.out) ? readdirSync(opts.out).filter((f) => f.endsWith(".gen.ts")) : [];
  const stale: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(opts.out, name);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== content) stale.push(name);
  }
  const extra = existing.filter((f) => !(f in files));
  if (opts.check) {
    const lines = [
      ...stale.map((f) => `${join(opts.out, f)} is stale: run \`bun run i18n:gen\``),
      ...extra.map((f) => `${join(opts.out, f)} has no catalog: run \`bun run i18n:gen\``),
    ];
    return { ok: lines.length === 0, lines };
  }
  mkdirSync(opts.out, { recursive: true });
  for (const name of stale) writeFileSync(join(opts.out, name), files[name] as string);
  for (const name of extra) rmSync(join(opts.out, name));
  return {
    ok: true,
    lines: [...stale.map((f) => `wrote ${join(opts.out, f)}`), ...extra.map((f) => `removed ${join(opts.out, f)}`)],
  };
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const catalogs = flag("--catalogs");
  const out = flag("--out");
  if (command !== "gen" || !catalogs || !out) {
    process.stderr.write("usage: cli.ts gen --catalogs <dir containing en/> --out <keys dir> [--check]\n");
    return 2;
  }
  const result = runGen({ catalogs, out, check: rest.includes("--check") });
  const stream = result.ok ? process.stdout : process.stderr;
  for (const line of result.lines) stream.write(`${line}\n`);
  return result.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
