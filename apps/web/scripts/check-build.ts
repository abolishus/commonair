// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Post-build guard: every `/assets/*.css` the SSR bundle links must exist in the client
 * assets, or server-rendered pages load unstyled (the stylesheet 404s). The client and SSR
 * builds each run Tailwind, and they once disagreed in the image build context.
 *
 *   bun scripts/check-build.ts [distDir]    (default: apps/web/dist)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CSS_REF = /\/assets\/([A-Za-z0-9_.-]+\.css)/g;

/** Stylesheet file names the given server sources link, sorted. */
export function linkedStylesheets(serverSources: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const source of serverSources) for (const [, name] of source.matchAll(CSS_REF)) if (name) names.add(name);
  return [...names].sort();
}

/** Stylesheet file names linked by the server sources that are not in `clientAssets`. */
export function missingStylesheets(serverSources: Iterable<string>, clientAssets: Iterable<string>): string[] {
  const present = new Set(clientAssets);
  return linkedStylesheets(serverSources).filter((name) => !present.has(name));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** Checks a `vp build` output directory; returns problems, empty when consistent. */
export function checkBuild(dist: string): string[] {
  const serverDir = join(dist, "server");
  const assetsDir = join(dist, "client", "assets");
  if (!existsSync(serverDir) || !existsSync(assetsDir)) return [`no build output under ${dist}`];
  const server = filesUnder(serverDir)
    .filter((f) => /\.m?js$/.test(f))
    .map((f) => readFileSync(f, "utf8"));
  if (linkedStylesheets(server).length === 0) return ["the server bundle links no /assets/*.css stylesheet"];
  return missingStylesheets(server, readdirSync(assetsDir)).map(
    (name) => `server bundle links /assets/${name}, which is not in ${assetsDir}`,
  );
}

if (import.meta.main) {
  const dist = process.argv[2] ?? join(import.meta.dirname, "..", "dist");
  const problems = checkBuild(dist);
  for (const p of problems) console.error(`check-build: ${p}`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write("check-build: client and server stylesheets agree\n");
}
