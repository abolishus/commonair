// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local infrastructure helper around `podman compose`.
 *
 *   bun scripts/infra.ts test   start the data services integration tests need, wait for health
 *   bun scripts/infra.ts stack  build and start the whole platform (+ harness profile), wait for health
 *   bun scripts/infra.ts down   stop everything (volumes kept)
 *   bun scripts/infra.ts reset  stop everything and delete volumes
 */
export const TEST_SERVICES = ["postgres", "valkey", "mailpit", "garage", "garage-init", "migrate"];
/** Long-running services that report health. */
export const HEALTHY_SERVICES = ["postgres", "valkey", "mailpit", "garage"];
/** One-shot jobs that must exit 0. */
export const ONE_SHOT_SERVICES = ["garage-init", "migrate"];
/** Long-running services of the whole platform plus the harness profile (`stack`). */
export const STACK_HEALTHY_SERVICES = [
  ...HEALTHY_SERVICES,
  "mediamtx",
  "api",
  "chat",
  "irc",
  "origin",
  "media",
  "worker",
  "web",
  "otel-collector",
  "prometheus",
  "loki",
  "tempo",
  "grafana",
  "mock-rtmp",
];
/** Locally built images the test subset needs (`migrate` shares the tools image). */
const BUILD_SERVICES = ["postgres", "garage-init"];
const PROJECT = "commonair";
const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
/** A service that restarted this often is crash-looping; waiting longer will not help. */
export const CRASH_LOOP_RESTARTS = 3;

function compose(args: string[], timeoutMs: number): void {
  const proc = Bun.spawnSync(["podman", "compose", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    // podman-compose waits on depends_on health with no deadline of its own.
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout)
    throw new Error(`podman compose ${args.join(" ")} timed out after ${timeoutMs / 1000}s\n${diagnose()}`);
  if (proc.exitCode !== 0) throw new Error(`podman compose ${args.join(" ")} failed (${proc.exitCode})\n${diagnose()}`);
}

export interface ContainerRow {
  name: string;
  service: string;
  workingDir: string;
  status: string;
  restarts: number;
}

function projectContainers(): ContainerRow[] {
  const out = Bun.spawnSync(
    [
      "podman",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${PROJECT}`,
      "--format",
      '{{.Names}}\t{{.Label "com.docker.compose.service"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.State}}\t{{.Restarts}}',
    ],
    { timeout: 30_000 },
  ).stdout.toString();
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", service = "", workingDir = "", status = "", restarts = "0"] = line.split("\t");
      return { name, service, workingDir, status, restarts: Number(restarts) || 0 };
    });
}

/**
 * Containers of the shared `commonair` project created from another checkout. They carry
 * that checkout's env (secrets included) and compose reuses them, so they must go first.
 */
export function foreignContainers(rows: ContainerRow[], root: string): ContainerRow[] {
  const norm = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/$/, "");
  return rows.filter((r) => r.workingDir && norm(r.workingDir) !== norm(root));
}

export function crashLooping(rows: ContainerRow[]): ContainerRow[] {
  return rows.filter((r) => r.restarts >= CRASH_LOOP_RESTARTS);
}

function preflight(): void {
  const foreign = foreignContainers(projectContainers(), ROOT);
  if (foreign.length === 0) return;
  const dirs = [...new Set(foreign.map((r) => r.workingDir))];
  throw new Error(
    `the "${PROJECT}" compose project is running from another checkout (${dirs.join(", ")}).\n` +
      `Its containers have that checkout's env and compose would reuse them here. Stop them\n` +
      `(volumes are kept) and rerun:  bun scripts/infra.ts down`,
  );
}

function diagnose(): string {
  const rows = projectContainers();
  const bad = rows.filter((r) => r.status !== "running" || r.restarts > 0);
  const lines = rows.map((r) => `  ${r.service.padEnd(16)} ${r.status} restarts=${r.restarts}`);
  for (const r of crashLooping(bad).slice(0, 3)) {
    const logs = Bun.spawnSync(["podman", "logs", "--tail", "5", r.name], { timeout: 10_000 });
    lines.push(`--- ${r.service} (last log lines)`, `${logs.stdout.toString()}${logs.stderr.toString()}`.trim());
  }
  return lines.join("\n");
}

function health(service: string): string {
  const id = Bun.spawnSync([
    "podman",
    "ps",
    "-q",
    "--filter",
    "label=com.docker.compose.project=commonair",
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ])
    .stdout.toString()
    .trim()
    .split("\n")[0];
  if (!id) return "missing";
  const out = Bun.spawnSync(["podman", "inspect", "-f", "{{.State.Health.Status}}", id]);
  return out.stdout.toString().trim() || "unknown";
}

function containerId(service: string): string | undefined {
  return Bun.spawnSync([
    "podman",
    "ps",
    "-a",
    "-q",
    "--filter",
    "label=com.docker.compose.project=commonair",
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ])
    .stdout.toString()
    .trim()
    .split("\n")[0];
}

/** Wait for one-shot jobs to exit; throws with the job's logs if one exits non-zero. */
export async function waitExited(services: string[], timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(services);
  while (pending.size > 0) {
    for (const s of pending) {
      const id = containerId(s);
      if (!id) continue;
      const out = Bun.spawnSync(["podman", "inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", id]);
      const [status, code] = out.stdout.toString().trim().split(" ");
      if (status !== "exited") continue;
      if (code !== "0") {
        const logs = Bun.spawnSync(["podman", "logs", "--tail", "40", id]);
        throw new Error(`${s} exited ${code}:\n${logs.stdout.toString()}${logs.stderr.toString()}`);
      }
      pending.delete(s);
    }
    if (pending.size === 0) return;
    // A job waiting on a crash-looping dependency never starts.
    const looping = crashLooping(projectContainers().filter((r) => r.status !== "running"));
    if (looping.length > 0)
      throw new Error(`crash-looping: ${looping.map((r) => r.service).join(", ")}\n${diagnose()}`);
    if (Date.now() > deadline)
      throw new Error(`one-shot jobs did not finish: ${[...pending].join(", ")}\n${diagnose()}`);
    await Bun.sleep(1000);
  }
}

export async function waitHealthy(services: string[], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = services.map((s) => [s, health(s)] as const);
    if (states.every(([, h]) => h === "healthy")) return;
    const unhealthy = new Set(states.filter(([, h]) => h !== "healthy").map(([s]) => s));
    const looping = crashLooping(projectContainers().filter((r) => unhealthy.has(r.service)));
    if (looping.length > 0)
      throw new Error(`crash-looping: ${looping.map((r) => r.service).join(", ")}\n${diagnose()}`);
    if (Date.now() > deadline)
      throw new Error(`services not healthy: ${states.map(([s, h]) => `${s}=${h}`).join(", ")}`);
    await Bun.sleep(1000);
  }
}

if (import.meta.main) {
  try {
    const cmd = process.argv[2];
    if (cmd === "test") {
      preflight();
      compose(["build", ...BUILD_SERVICES], 20 * 60_000);
      compose(["up", "-d", ...TEST_SERVICES], 5 * 60_000);
      await waitHealthy(HEALTHY_SERVICES);
      await waitExited(ONE_SHOT_SERVICES);
      console.log(`infra: ${TEST_SERVICES.join(", ")} healthy`);
    } else if (cmd === "stack") {
      preflight();
      compose(["--profile", "harness", "build"], 20 * 60_000);
      compose(["--profile", "harness", "up", "-d"], 10 * 60_000);
      await waitExited(ONE_SHOT_SERVICES);
      await waitHealthy(STACK_HEALTHY_SERVICES, 300_000);
      console.log("infra: platform healthy");
    } else if (cmd === "down") {
      compose(["down"], 5 * 60_000);
    } else if (cmd === "reset") {
      compose(["down", "-v"], 5 * 60_000);
    } else {
      console.error("usage: bun scripts/infra.ts test|stack|down|reset");
      process.exit(2);
    }
  } catch (e) {
    console.error(`infra: ${(e as Error).message}`);
    process.exit(1);
  }
}
