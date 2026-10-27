// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The single verification gate. Every agent, contributor and CI job runs this.
 *
 *   bun run verify                 format → lint+types → unit → integration → repo policy → supply chain → relay
 *   bun run verify --quick         skip integration tests (inner loop only; never the commit gate)
 *   bun run verify --scenario chat ...plus the named harness scenario(s)
 *   bun run verify:full            everything, plus the full harness scenario
 *   bun run verify --full --shard rest  ...with one part of it (CI runs each shard as a job)
 *   bun run verify --only static,unit   only those step groups (CI runs each group as its own job)
 *
 * Groups: static (format, lint, types, repo policy, supply chain), unit, integration (infra,
 * migrations, test:int), relay (Go), harness (platform up and scenarios).
 *
 * Workspace tasks run with --no-cache: the task cache keys on a package's own inputs and can
 * replay a stale pass when a dependency changed.
 *
 * Integration tests need Postgres, Valkey, Garage and Mailpit: verify starts
 * them with `podman compose` (scripts/infra.ts) unless VERIFY_INFRA=external.
 *
 * Every step has a hard timeout (minutes, scaled by VERIFY_TIMEOUT_SCALE, e.g. 2 on a slow
 * machine): a hung step fails the gate with its name instead of leaving it running forever.
 */
import { existsSync } from "node:fs";
import { killCurrentStep, runStep } from "./run-step.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const quick = args.includes("--quick");
const scenarios = args.flatMap((a, i) => (a === "--scenario" && args[i + 1] ? [args[i + 1]!] : []));
const shard = fullScenarioArg(args);

export const GROUPS = ["static", "unit", "integration", "relay", "harness"] as const;
export type Group = (typeof GROUPS)[number];

/** The groups `--only a,b` selects (all of them without the flag); throws on an unknown name. */
export function selectGroups(argv: string[]): Set<Group> {
  const i = argv.indexOf("--only");
  if (i === -1) return new Set(GROUPS);
  const names = (argv[i + 1] ?? "").split(",").filter(Boolean);
  if (names.length === 0) throw new Error(`--only needs a group list: ${GROUPS.join(", ")}`);
  for (const n of names)
    if (!(GROUPS as readonly string[]).includes(n))
      throw new Error(`unknown verify group "${n}"; groups: ${GROUPS.join(", ")}`);
  return new Set(names as Group[]);
}

interface Step {
  name: string;
  group: Group;
  cmd: string[];
  cwd?: string;
  /** Hard limit in minutes before the step's process tree is killed. */
  timeoutMin: number;
  when?: () => boolean;
}

/** The harness name the full step runs: `full`, or `full:<shard>` with `--shard <shard>`. */
export function fullScenarioArg(argv: readonly string[]): string {
  const name = argv[argv.indexOf("--shard") + 1];
  return argv.includes("--shard") && name ? `full:${name}` : "full";
}

/** Why the `--shard` arguments are unusable, or null. The harness CLI checks the name itself. */
export function shardError(argv: readonly string[]): string | null {
  if (!argv.includes("--shard")) return null;
  const name = argv[argv.indexOf("--shard") + 1];
  if (!name || name.startsWith("-")) return "--shard needs a shard name (FULL_SHARDS in harness/src/shards.ts)";
  if (!argv.includes("--full")) return "--shard runs part of the full scenario: pass --full too";
  return null;
}

/** `infra up`: with the harness overrides when harness scenarios run in the same gate. */
export function infraUpCmd(harnessFollows: boolean): string[] {
  return ["bun", "scripts/infra.ts", "test", ...(harnessFollows ? ["--harness"] : [])];
}

export const steps: Step[] = [
  { name: "format", group: "static", timeoutMin: 5, cmd: ["vp", "fmt", "--check"] },
  { name: "lint", group: "static", timeoutMin: 10, cmd: ["vp", "lint", "--deny-warnings"] },
  { name: "typecheck", group: "static", timeoutMin: 10, cmd: ["vp", "run", "--no-cache", "-r", "typecheck"] },
  { name: "unit tests", group: "unit", timeoutMin: 15, cmd: ["vp", "run", "--no-cache", "-r", "test"] },
  {
    // With harness scenarios to follow, the data services start with the harness overrides: the
    // E5 governance bootstrap applies only at the volume's first migration (ADR 0020), and this
    // migrate runs before platform up's.
    name: "infra up",
    group: "integration",
    timeoutMin: 10,
    cmd: infraUpCmd(full || scenarios.length > 0),
    when: () => !quick && process.env.VERIFY_INFRA !== "external",
  },
  {
    name: "migrations",
    group: "integration",
    timeoutMin: 3,
    cmd: ["bun", "run", "--filter", "@commonair/db", "migrate"],
    when: () => !quick && existsSync("packages/db/package.json"),
  },
  {
    name: "integration tests",
    group: "integration",
    timeoutMin: 30,
    cmd: ["vp", "run", "--no-cache", "-r", "test:int"],
    when: () => !quick,
  },
  { name: "licenses", group: "static", timeoutMin: 5, cmd: ["bun", "scripts/check-licenses.ts"] },
  // Pins, cooldown, install scripts, advisories, action SHAs, image digests (ADR 0022). Needs the network.
  { name: "supply chain", group: "static", timeoutMin: 5, cmd: ["bun", "scripts/check-supply-chain.ts"] },
  { name: "stray domains", group: "static", timeoutMin: 5, cmd: ["bun", "scripts/check-domains.ts"] },
  { name: "reuse lint", group: "static", timeoutMin: 5, cmd: ["reuse", "lint", "--quiet"] },
  // OpenTofu fmt, validate and mocked-provider tests; check.sh skips with a message without
  // tofu, and CI sets REQUIRE_TOFU=1 so it cannot skip there.
  { name: "tofu", group: "static", timeoutMin: 10, cmd: ["bash", "infra/tofu/check.sh"] },
  {
    name: "relay: gofmt",
    group: "relay",
    timeoutMin: 2,
    cmd: ["bash", "-c", 'test -z "$(gofmt -l .)" || (gofmt -l . && exit 1)'],
    cwd: "relay",
    when: () => existsSync("relay/go.mod"),
  },
  {
    name: "relay: vet + test",
    group: "relay",
    timeoutMin: 10,
    cmd: ["bash", "-c", "go vet ./... && go test -race ./..."],
    cwd: "relay",
    when: () => existsSync("relay/go.mod"),
  },
  {
    // Known vulnerabilities in the Go toolchain's stdlib and any module the relay imports.
    name: "relay: govulncheck",
    group: "relay",
    timeoutMin: 5,
    cmd: ["bun", "scripts/check-go-vulns.ts"],
    when: () => existsSync("relay/go.mod"),
  },
  {
    // Harness scenarios drive the whole platform in real browsers. They need the harness
    // overrides (test hooks, short governance periods, private-network outbound): the plain
    // stack fails half of `full`.
    name: "platform up",
    group: "harness",
    timeoutMin: 25,
    // --multi: the second api/chat/worker/origin the `multi-instance` scenario needs (S1-c).
    cmd: ["bun", "scripts/infra.ts", "stack", "--harness", "--multi"],
    when: () => (full || scenarios.length > 0) && process.env.VERIFY_INFRA !== "external",
  },
  {
    name: "harness: browsers",
    group: "harness",
    timeoutMin: 10,
    cmd: ["bun", "run", "--filter", "@commonair/harness", "browsers"],
    when: () => full || scenarios.length > 0,
  },
  ...scenarios.map((s) => ({
    name: `harness: ${s}`,
    group: "harness" as const,
    timeoutMin: 30,
    cmd: ["bun", "harness/src/cli.ts", "run", s],
  })),
  {
    name: shard === "full" ? "harness: full scenario" : `harness: ${shard}`,
    group: "harness",
    timeoutMin: 45,
    cmd: ["bun", "harness/src/cli.ts", "run", shard],
    when: () => full,
  },
];

// Imported by its tests; runs only as a script.
if (import.meta.main) {
  let only: Set<Group>;
  try {
    only = selectGroups(args);
    const bad = shardError(args);
    if (bad) throw new Error(bad);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const scale = Number(process.env.VERIFY_TIMEOUT_SCALE ?? "1") || 1;
  // Steps run in their own process group, so Ctrl-C has to be forwarded to it.
  for (const sig of ["SIGINT", "SIGTERM"] as const)
    process.on(sig, () => {
      killCurrentStep();
      process.exit(130);
    });

  const started = performance.now();
  const results: { name: string; ms: number; ok: boolean | "skipped"; timedOut?: boolean }[] = [];
  for (const step of steps) {
    if (!only.has(step.group)) continue;
    if (step.when && !step.when()) {
      results.push({ name: step.name, ms: 0, ok: "skipped" });
      continue;
    }
    const timeoutMs = step.timeoutMin * scale * 60_000;
    console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m  ${step.cmd.join(" ")}  (limit ${step.timeoutMin * scale}m)`);
    let r = { ok: false, timedOut: false, ms: 0 };
    try {
      r = await runStep(step.cmd, { cwd: step.cwd, timeoutMs, heartbeatMs: 60_000 });
    } catch (e) {
      console.error(`could not run ${step.cmd[0]}: ${(e as Error).message} (is it installed and on PATH?)`);
    }
    results.push({ name: step.name, ms: r.ms, ok: r.ok, timedOut: r.timedOut });
    if (!r.ok) break;
  }

  console.log("\n\x1b[1mverify summary\x1b[0m");
  for (const r of results) {
    const mark = r.ok === "skipped" ? "–" : r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      `  ${mark} ${r.name.padEnd(28)} ${r.ok === "skipped" ? "skipped" : `${(r.ms / 1000).toFixed(1)}s`}${r.timedOut ? " (timed out)" : ""}`,
    );
  }
  const failed = results.some((r) => r.ok === false);
  console.log(
    `\n${failed ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  process.exit(failed ? 1 : 0);
}
