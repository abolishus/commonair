// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single verification gate. Every agent, contributor and CI job runs this.
 *
 *   bun run verify                 format → lint+types → unit → integration → repo policy → relay
 *   bun run verify --quick         skip integration tests (inner loop only; never the commit gate)
 *   bun run verify --scenario chat ...plus the named harness scenario(s)
 *   bun run verify:full            everything, plus the full harness scenario
 *
 * Integration tests need Postgres, Valkey, Garage and Mailpit: verify starts
 * them with `podman compose` (scripts/infra.ts) unless VERIFY_INFRA=external.
 */
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const full = args.includes("--full");
const quick = args.includes("--quick");
const scenarios = args.flatMap((a, i) => (a === "--scenario" && args[i + 1] ? [args[i + 1]!] : []));

interface Step {
  name: string;
  cmd: string[];
  cwd?: string;
  when?: () => boolean;
}

const steps: Step[] = [
  { name: "format", cmd: ["vp", "fmt", "--check"] },
  { name: "lint", cmd: ["vp", "lint", "--deny-warnings"] },
  { name: "typecheck", cmd: ["vp", "run", "-r", "typecheck"] },
  { name: "unit tests", cmd: ["vp", "run", "-r", "test"] },
  {
    name: "infra up",
    cmd: ["bun", "scripts/infra.ts", "test"],
    when: () => !quick && process.env.VERIFY_INFRA !== "external",
  },
  {
    name: "migrations",
    cmd: ["bun", "run", "--filter", "@commonair/db", "migrate"],
    when: () => !quick && existsSync("packages/db/package.json"),
  },
  { name: "integration tests", cmd: ["vp", "run", "-r", "test:int"], when: () => !quick },
  { name: "licenses", cmd: ["bun", "scripts/check-licenses.ts"] },
  { name: "stray domains", cmd: ["bun", "scripts/check-domains.ts"] },
  { name: "reuse lint", cmd: ["reuse", "lint", "--quiet"] },
  {
    name: "relay: gofmt",
    cmd: ["bash", "-c", 'test -z "$(gofmt -l .)" || (gofmt -l . && exit 1)'],
    cwd: "relay",
    when: () => existsSync("relay/go.mod"),
  },
  {
    name: "relay: vet + test",
    cmd: ["bash", "-c", "go vet ./... && go test -race ./..."],
    cwd: "relay",
    when: () => existsSync("relay/go.mod"),
  },
  ...scenarios.map((s) => ({
    name: `harness: ${s}`,
    cmd: ["bun", "harness/src/cli.ts", "run", s],
  })),
  {
    name: "harness: full scenario",
    cmd: ["bun", "harness/src/cli.ts", "run", "full"],
    when: () => full,
  },
];

const started = performance.now();
const results: { name: string; ms: number; ok: boolean | "skipped" }[] = [];
for (const step of steps) {
  if (step.when && !step.when()) {
    results.push({ name: step.name, ms: 0, ok: "skipped" });
    continue;
  }
  console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m  ${step.cmd.join(" ")}`);
  const t = performance.now();
  let ok = false;
  try {
    const proc = Bun.spawnSync(step.cmd, { cwd: step.cwd, stdio: ["inherit", "inherit", "inherit"], env: process.env });
    ok = proc.exitCode === 0;
  } catch (e) {
    console.error(`could not run ${step.cmd[0]}: ${(e as Error).message} (is it installed and on PATH?)`);
  }
  results.push({ name: step.name, ms: performance.now() - t, ok });
  if (!ok) break;
}

console.log("\n\x1b[1mverify summary\x1b[0m");
for (const r of results) {
  const mark = r.ok === "skipped" ? "–" : r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${mark} ${r.name.padEnd(28)} ${r.ok === "skipped" ? "skipped" : `${(r.ms / 1000).toFixed(1)}s`}`);
}
const failed = results.some((r) => r.ok === false);
console.log(
  `\n${failed ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
);
process.exit(failed ? 1 : 0);
