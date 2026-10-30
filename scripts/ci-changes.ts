// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which of CI's expensive jobs a push needs (`ci.yml` job `changes`). The gate always runs. The
 * harness runs only the scenarios a push can affect: none for docs, briefs and tests alone; for a
 * change inside the harness, the scenarios whose modules import the changed file (transitively);
 * every scenario for anything else. The release dry run and the self-host end-to-end run only when
 * something they build or install changed. The nightly run and a manual dispatch run everything,
 * as does any push whose diff cannot be read.
 *
 * Usage (CI): `bun scripts/ci-changes.ts` with EVENT_NAME, BASE (the last green run's commit on
 * main) and SHA set; writes `code`, `scenarios` (`all`, a comma list or empty), `shards` (a JSON
 * list for the harness matrix) and `deploy` to $GITHUB_OUTPUT. It runs before `bun install`, so it
 * imports nothing outside the standard library and `harness/src/shards.ts` (which has no imports).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FULL_SHARDS } from "../harness/src/shards.ts";

export const ALL = "all";
export type Selection = typeof ALL | readonly string[];

export interface Changes {
  /** Harness scenarios to run: `all`, or the names (empty: the harness is skipped). */
  scenarios: Selection;
  /** Images, the installer, release tooling, compose, workflows, lockfiles or migrations. */
  deploy: boolean;
}

export const EVERYTHING: Changes = { scenarios: ALL, deploy: true };

/** Docs and planning text no test or build reads (docs/testing, docs/self-hosting and docs/developers are read by tests). */
export function isDocsOnly(path: string): boolean {
  if (path.startsWith(".claude/")) return true;
  if (path.startsWith("docs/")) return !/^docs\/(testing|self-hosting|developers)\//.test(path) && path.endsWith(".md");
  // Top-level prose (README, PROGRESS, PLAN, CHANGELOG, …); nested READMEs are prose too.
  if (!path.includes("/") && path.endsWith(".md")) return true;
  return /(^|\/)README\.md$/.test(path) && !path.startsWith("packages/db/src/legal/");
}

/** Tests and stories: the gate runs them; no scenario does. */
export const isTestOnly = (path: string): boolean =>
  /\.(test|int\.test)\.tsx?$/.test(path) || /(^|\/)tests\//.test(path) || /\.stories\.tsx?$/.test(path);

const DEPLOY: readonly RegExp[] = [
  /^infra\//,
  /^scripts\/selfhost(\.sh|\/)/,
  /^scripts\/release\//,
  /^scripts\/infra\.ts$/,
  /(^|\/)compose[^/]*\.ya?ml$/,
  /Containerfile/,
  /^\.github\/workflows\/(ci|release)\.yml$/,
  /(^|\/)bun\.lock$/,
  /^package\.json$/,
  /^relay\/go\.(mod|sum)$/,
  /^packages\/db\/drizzle\//,
  /^\.env\.example$/,
];

export const isDeploy = (path: string): boolean => DEPLOY.some((re) => re.test(path));

/** Repository-relative `.ts` module → the repository-relative modules it imports by relative path. */
export type ImportGraph = ReadonlyMap<string, readonly string[]>;

const SCENARIOS = "harness/scenarios/";
const IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+\.tsx?)["']/g;

/** A scenario module's name: its file name (the registry checks the two agree). */
const scenarioOf = (path: string): string | null =>
  path.startsWith(SCENARIOS) && !path.slice(SCENARIOS.length).includes("/") && !basename(path).startsWith("_")
    ? basename(path, ".ts")
    : null;

/** The harness's module graph, read from disk (tests excluded: no scenario imports them). */
export function harnessGraph(root: string): ImportGraph {
  const graph = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name) && !isTestOnly(rel)) {
        const text = readFileSync(join(root, rel), "utf8");
        const deps = [...text.matchAll(IMPORT)].map((m) => normalize(join(dirname(rel), m[1] ?? "")));
        graph.set(rel, deps);
      }
    }
  };
  for (const dir of ["harness/src", "harness/scenarios"]) if (existsSync(join(root, dir))) walk(dir);
  return graph;
}

/** The scenarios whose modules reach `path` through imports (a scenario's own file included). */
export function scenariosReaching(path: string, graph: ImportGraph): string[] {
  const out: string[] = [];
  for (const start of graph.keys()) {
    const name = scenarioOf(start);
    if (!name) continue;
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const at = stack.pop() as string;
      if (at === path) {
        out.push(name);
        break;
      }
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(graph.get(at) ?? []));
    }
  }
  return out.sort();
}

/**
 * The scenarios `files` can affect. Only a `.ts` module inside the harness that some scenario
 * imports narrows the run; anything else that is not docs or tests (product code, harness runtime
 * no scenario imports, compose files, fixtures, a deleted module) selects every scenario.
 */
export function selectScenarios(files: readonly string[], graph: ImportGraph): Selection {
  const picked = new Set<string>();
  for (const f of files) {
    if (isDocsOnly(f) || isTestOnly(f)) continue;
    if (!/^harness\/(src|scenarios)\/.+\.tsx?$/.test(f) || !graph.has(f)) return ALL;
    const reached = scenariosReaching(f, graph);
    if (reached.length === 0) return ALL;
    for (const s of reached) picked.add(s);
  }
  return [...picked].sort();
}

/** The harness shards a selection needs, in FULL_SHARDS order (a scenario no shard names is in `rest`). */
export function shardsFor(selection: Selection): string[] {
  const all = Object.keys(FULL_SHARDS);
  if (selection === ALL) return all;
  const shards = Object.entries(FULL_SHARDS) as [string, readonly string[] | null][];
  // The one shard with no list takes every scenario the others leave.
  const rest = shards.find(([, list]) => list === null)?.[0] ?? "rest";
  const needed = new Set(selection.map((s) => shards.find(([, list]) => list?.includes(s))?.[0] ?? rest));
  return all.filter((k) => needed.has(k));
}

export function classify(files: readonly string[], graph: ImportGraph): Changes {
  return { scenarios: selectScenarios(files, graph), deploy: files.some(isDeploy) };
}

/** A push's changes since BASE, or everything when the event is not a push or the diff cannot be read. */
export function changesFor(
  env: { EVENT_NAME?: string; BASE?: string; SHA?: string },
  root = fileURLToPath(new URL("..", import.meta.url)),
): Changes {
  const { EVENT_NAME, BASE, SHA } = env;
  if (EVENT_NAME !== "push" || !BASE || !SHA || /^0+$/.test(BASE)) return EVERYTHING;
  try {
    const out = execFileSync("git", ["diff", "--name-only", BASE, SHA], { encoding: "utf8", cwd: root });
    const files = out.split("\n").filter(Boolean);
    return files.length === 0 ? EVERYTHING : classify(files, harnessGraph(root));
  } catch {
    return EVERYTHING;
  }
}

/** The step outputs. `shards` is never empty: an empty matrix is an error even on a skipped job. */
export function outputs(c: Changes): string {
  const scenarios = c.scenarios === ALL ? ALL : c.scenarios.join(",");
  const shards = c.scenarios === ALL || c.scenarios.length > 0 ? shardsFor(c.scenarios) : Object.keys(FULL_SHARDS);
  return `code=${scenarios !== ""}\nscenarios=${scenarios}\nshards=${JSON.stringify(shards)}\ndeploy=${c.deploy}\n`;
}

if (import.meta.main) {
  const { EVENT_NAME, BASE, SHA } = process.env;
  const lines = outputs(changesFor({ EVENT_NAME, BASE, SHA }));
  process.stdout.write(lines);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
