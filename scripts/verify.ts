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
 *
 * Steps run in phases; within a phase each group is a lane, and lanes run side by side:
 *   1. format, lint, typecheck (seconds, the commonest failures) | relay
 *   2. unit tests | the light repo-policy checks | infra up, migrations
 *   3. integration tests
 *   4. harness
 * No two CPU- or memory-heavy steps share a phase: type-aware lint beside the unit run took
 * eight times as long and pushed timing-sensitive unit tests past their timeouts. Side-by-side
 * steps write to log files, printed as each finishes; the first failure cancels the rest. A lone
 * lane (CI's one group per job) streams to the terminal as before. `--serial` runs one step at
 * a time, streaming.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killCurrentStep, runStep, type StepResult } from "./run-step.ts";

const args = process.argv.slice(2);
const full = args.includes("--full");
const quick = args.includes("--quick");
const serial = args.includes("--serial");
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
  /** Phases run in order (default 1); steps of one phase and group run in order, groups side by side. */
  phase?: number;
  when?: () => boolean;
}

/** Phases in order, each a list of lanes (one per group, in first-seen order) of steps in order. */
export function phases(selected: readonly Step[]): Step[][][] {
  const byPhase = new Map<number, Map<Group, Step[]>>();
  for (const s of selected) {
    const p = s.phase ?? 1;
    const lanes = byPhase.get(p) ?? new Map<Group, Step[]>();
    byPhase.set(p, lanes);
    lanes.set(s.group, [...(lanes.get(s.group) ?? []), s]);
  }
  return [...byPhase.entries()].sort(([a], [b]) => a - b).map(([, lanes]) => [...lanes.values()]);
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
  { name: "unit tests", group: "unit", phase: 2, timeoutMin: 15, cmd: ["vp", "run", "--no-cache", "-r", "test"] },
  {
    // With harness scenarios to follow, the data services start with the harness overrides: the
    // E5 governance bootstrap applies only at the volume's first migration (ADR 0020), and this
    // migrate runs before platform up's.
    name: "infra up",
    group: "integration",
    phase: 2,
    timeoutMin: 10,
    cmd: infraUpCmd(full || scenarios.length > 0),
    when: () => !quick && process.env.VERIFY_INFRA !== "external",
  },
  {
    name: "migrations",
    group: "integration",
    phase: 2,
    timeoutMin: 3,
    cmd: ["bun", "run", "--filter", "@commonair/db", "migrate"],
    when: () => !quick && existsSync("packages/db/package.json"),
  },
  {
    name: "integration tests",
    group: "integration",
    phase: 3,
    timeoutMin: 30,
    cmd: ["vp", "run", "--no-cache", "-r", "test:int"],
    when: () => !quick,
  },
  { name: "licenses", group: "static", phase: 2, timeoutMin: 5, cmd: ["bun", "scripts/check-licenses.ts"] },
  // Pins, cooldown, install scripts, advisories, action SHAs, image digests (ADR 0022). Needs the network.
  { name: "supply chain", group: "static", phase: 2, timeoutMin: 5, cmd: ["bun", "scripts/check-supply-chain.ts"] },
  { name: "stray domains", group: "static", phase: 2, timeoutMin: 5, cmd: ["bun", "scripts/check-domains.ts"] },
  { name: "reuse lint", group: "static", phase: 2, timeoutMin: 5, cmd: ["reuse", "lint", "--quiet"] },
  // OpenTofu fmt, validate and mocked-provider tests; check.sh skips with a message without
  // tofu, and CI sets REQUIRE_TOFU=1 so it cannot skip there.
  { name: "tofu", group: "static", phase: 2, timeoutMin: 10, cmd: ["bash", "infra/tofu/check.sh"] },
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
    phase: 4,
    timeoutMin: 25,
    // --multi: the second api/chat/worker/origin the `multi-instance` scenario needs (S1-c).
    cmd: ["bun", "scripts/infra.ts", "stack", "--harness", "--multi"],
    when: () => (full || scenarios.length > 0) && process.env.VERIFY_INFRA !== "external",
  },
  {
    name: "harness: browsers",
    group: "harness",
    phase: 4,
    timeoutMin: 10,
    cmd: ["bun", "run", "--filter", "@commonair/harness", "browsers"],
    when: () => full || scenarios.length > 0,
  },
  ...scenarios.map((s) => ({
    name: `harness: ${s}`,
    group: "harness" as const,
    phase: 4,
    timeoutMin: 30,
    cmd: ["bun", "harness/src/cli.ts", "run", s],
  })),
  {
    name: shard === "full" ? "harness: full scenario" : `harness: ${shard}`,
    group: "harness",
    phase: 4,
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
  const selected = steps.filter((s) => only.has(s.group));
  const results = new Map<Step, { ms: number; ok: boolean | "skipped"; timedOut?: boolean; cancelled?: boolean }>();
  const logDir = mkdtempSync(join(tmpdir(), "commonair-verify-"));
  const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const elapsed = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

  async function run(step: Step, sideBySide: boolean, signal: AbortSignal): Promise<boolean> {
    if (step.when && !step.when()) {
      results.set(step, { ms: 0, ok: "skipped" });
      return true;
    }
    const timeoutMs = step.timeoutMin * scale * 60_000;
    const logFile = sideBySide ? join(logDir, `${slug(step.name)}.log`) : undefined;
    console.log(`\n\x1b[1m▶ ${step.name}\x1b[0m  ${step.cmd.join(" ")}  (limit ${step.timeoutMin * scale}m)`);
    let r: StepResult = { ok: false, timedOut: false, cancelled: false, exitCode: null, ms: 0 };
    try {
      r = await runStep(step.cmd, {
        cwd: step.cwd,
        timeoutMs,
        heartbeatMs: 60_000,
        logFile,
        signal,
        log: sideBySide ? (l) => console.log(`  [${step.name}]${l.replace(/^ +/, " ")}`) : undefined,
      });
    } catch (e) {
      console.error(`could not run ${step.cmd[0]}: ${(e as Error).message} (is it installed and on PATH?)`);
    }
    results.set(step, { ms: r.ms, ok: r.ok, timedOut: r.timedOut, cancelled: r.cancelled });
    if (logFile && !r.cancelled) {
      const out = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      // A pass shows its tail (the counts); a failure shows everything.
      const shown = r.ok ? out.trimEnd().split("\n").slice(-12).join("\n") : out;
      const mark = r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      console.log(`\n${mark} \x1b[1m${step.name}\x1b[0m ${elapsed(r.ms)}  (${logFile})\n${shown}`);
    }
    return r.ok;
  }

  for (const lanes of phases(selected)) {
    const sideBySide = !serial && lanes.length > 1;
    const abort = new AbortController();
    const runLane = async (lane: Step[]) => {
      for (const step of lane) {
        if (abort.signal.aborted) return;
        if (!(await run(step, sideBySide, abort.signal))) return abort.abort();
      }
    };
    if (sideBySide) await Promise.all(lanes.map(runLane));
    else for (const lane of lanes) await runLane(lane);
    if (abort.signal.aborted) break;
  }

  console.log("\n\x1b[1mverify summary\x1b[0m");
  for (const step of selected) {
    const r = results.get(step);
    if (!r) continue;
    const mark = r.ok === "skipped" ? "–" : r.ok ? "\x1b[32m✓\x1b[0m" : r.cancelled ? "–" : "\x1b[31m✗\x1b[0m";
    const time = r.ok === "skipped" ? "skipped" : r.cancelled ? "cancelled" : elapsed(r.ms);
    console.log(`  ${mark} ${step.name.padEnd(28)} ${time}${r.timedOut ? " (timed out)" : ""}`);
  }
  const failed = [...results.values()].some((r) => r.ok === false && !r.cancelled);
  console.log(
    `\n${failed ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
  );
  // Logs of a red run stay for reading; a green run's go.
  if (failed) console.log(`step logs: ${logDir}`);
  else rmSync(logDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
