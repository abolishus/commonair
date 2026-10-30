// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit-test line coverage across every workspace, for the README badge.
 *
 * Runs each workspace's `test` script with Istanbul coverage (the v8 provider needs
 * `node:inspector`, which Bun does not implement), merges the per-workspace summaries, and
 * writes a shields.io endpoint file. Every source file counts, tested or not, so the number
 * cannot rise by leaving files untested.
 *
 *   bun scripts/coverage.ts [--out <badge.json>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Counts {
  total: number;
  covered: number;
}
export interface WorkspaceCoverage {
  name: string;
  lines: Counts;
}
export interface Badge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
}

export const COVERAGE_ARGS = [
  "--coverage.enabled",
  "--coverage.provider=istanbul",
  "--coverage.reporter=json-summary",
  "--coverage.include=src/**/*.{ts,tsx}",
  "--coverage.exclude=**/*.gen.*",
  "--coverage.exclude=**/*.stories.tsx",
  "--coverage.exclude=**/*.d.ts",
  // Instrumentation makes cold imports ~4x slower (the harness tests that load every scenario
  // module then cross 5 s). Timing is ci.yml's gate; this run only measures.
  "--testTimeout=60000",
];

export function percent(c: Counts): number {
  // An empty workspace is not evidence of anything; callers skip it.
  return c.total === 0 ? 0 : (c.covered / c.total) * 100;
}

export function merge(workspaces: readonly WorkspaceCoverage[]): Counts {
  return workspaces.reduce((a, w) => ({ total: a.total + w.lines.total, covered: a.covered + w.lines.covered }), {
    total: 0,
    covered: 0,
  });
}

export function badge(c: Counts, testsPassed = true): Badge {
  // A partial run would show a number for code whose tests did not all run.
  if (!testsPassed) return { schemaVersion: 1, label: "unit coverage", message: "tests failing", color: "red" };
  if (c.total === 0) return { schemaVersion: 1, label: "unit coverage", message: "unknown", color: "lightgrey" };
  const p = percent(c);
  const color =
    p >= 90
      ? "brightgreen"
      : p >= 80
        ? "green"
        : p >= 70
          ? "yellowgreen"
          : p >= 60
            ? "yellow"
            : p >= 50
              ? "orange"
              : "red";
  // Floor, not round: 89.96% must not read as 90%.
  return { schemaVersion: 1, label: "unit coverage", message: `${Math.floor(p * 10) / 10}%`, color };
}

export function table(workspaces: readonly WorkspaceCoverage[]): string {
  const rows = [...workspaces]
    .filter((w) => w.lines.total > 0)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((w) => `| ${w.name} | ${percent(w.lines).toFixed(1)}% | ${w.lines.covered} / ${w.lines.total} |`);
  const all = merge(workspaces);
  return [
    "| Workspace | Lines | Covered / total |",
    "| --- | ---: | ---: |",
    ...rows,
    `| **all** | **${percent(all).toFixed(1)}%** | **${all.covered} / ${all.total}** |`,
  ].join("\n");
}

/** Workspace directories from the root manifest's globs (each holds a package.json). */
function workspaceDirs(): string[] {
  const globs = (JSON.parse(readFileSync("package.json", "utf8")) as { workspaces: string[] }).workspaces;
  return globs.flatMap((g) => [...new Bun.Glob(`${g}/package.json`).scanSync({ onlyFiles: true })].map(dirname));
}

if (import.meta.main) {
  const outIdx = process.argv.indexOf("--out");
  const out = outIdx === -1 ? "coverage/badge.json" : process.argv[outIdx + 1];
  if (out === undefined) throw new Error("--out needs a path");

  const run = Bun.spawnSync(["vp", "run", "--no-cache", "-r", "test", ...COVERAGE_ARGS], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const workspaces = workspaceDirs().flatMap((dir): WorkspaceCoverage[] => {
    const summary = join(dir, "coverage", "coverage-summary.json");
    if (!existsSync(summary)) return [];
    const { total } = JSON.parse(readFileSync(summary, "utf8")) as { total: { lines: Counts } };
    return [{ name: dir, lines: { total: total.lines.total, covered: total.lines.covered } }];
  });

  const md = table(workspaces);
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Unit coverage\n\n${md}\n`, { flag: "a" });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(badge(merge(workspaces), run.exitCode === 0))}\n`);
  if (run.exitCode !== 0) {
    console.error(`unit tests failed (exit ${run.exitCode}); the badge says so.`);
    process.exit(1);
  }
}
