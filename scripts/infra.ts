// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local infrastructure helper around `podman compose`.
 *
 *   bun scripts/infra.ts test   start the data services integration tests need, wait for health
 *   bun scripts/infra.ts stack [override.yaml...]
 *                               build and start the whole platform (+ harness profile), wait for health;
 *                               override files are layered over compose.yaml (e.g.
 *                               harness/compose.trust-safety.yaml for the `trust-safety` scenario)
 *   bun scripts/infra.ts down   stop everything (volumes kept)
 *   bun scripts/infra.ts reset  stop everything and delete volumes
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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

/**
 * podman-compose runs every build and start at once, and on macOS each is an SSH connection into
 * the Podman VM. Its sshd refuses new handshakes once 10 are pending (MaxStartups 10:30), which
 * surfaces as "ssh: handshake failed" or "internal libpod error" (125).
 */
const COMPOSE_PARALLEL = "4";

function compose(args: string[], timeoutMs: number): void {
  const proc = Bun.spawnSync(["podman", "compose", "--parallel", COMPOSE_PARALLEL, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    // podman-compose waits on depends_on health with no deadline of its own.
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout)
    throw new Error(`podman compose ${args.join(" ")} timed out after ${timeoutMs / 1000}s\n${diagnose()}`);
  if (proc.exitCode !== 0) throw new Error(`podman compose ${args.join(" ")} failed (${proc.exitCode})\n${diagnose()}`);
}

/**
 * `up -d` is idempotent, so retry it once: a transient failure talking to the Podman VM (see
 * COMPOSE_PARALLEL) should not fail the gate when a second pass starts everything cleanly.
 */
function composeUp(args: string[], timeoutMs: number): void {
  try {
    compose(args, timeoutMs);
  } catch (e) {
    if ((e as Error).message.includes("timed out")) throw e;
    console.warn(`infra: podman compose ${args.join(" ")} failed; retrying once`);
    compose(args, timeoutMs);
  }
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

export interface ImageRow {
  name: string;
  /** Short or full id of the image the container was created from. */
  imageId: string;
  image: string;
}

/**
 * Containers whose image tag now points at a newer build. podman-compose's `up -d` recreates a
 * container when its config changes but not when only its image does, so after a build the
 * stack would keep serving the old code.
 */
export function staleImageContainers(rows: ImageRow[], current: ReadonlyMap<string, string>): ImageRow[] {
  return rows.filter((r) => {
    const id = current.get(r.image);
    return id !== undefined && r.imageId !== "" && !id.startsWith(r.imageId);
  });
}

function removeStaleImageContainers(): void {
  const out = Bun.spawnSync(
    [
      "podman",
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${PROJECT}`,
      "--format",
      "{{.Names}}\t{{.ImageID}}\t{{.Image}}",
    ],
    { timeout: 30_000 },
  ).stdout.toString();
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", imageId = "", image = ""] = line.split("\t");
      return { name, imageId, image };
    });
  const current = new Map<string, string>();
  for (const image of new Set(rows.map((r) => r.image))) {
    const p = Bun.spawnSync(["podman", "image", "inspect", "--format", "{{.Id}}", image], { timeout: 30_000 });
    if (p.exitCode === 0) current.set(image, p.stdout.toString().trim());
  }
  const stale = staleImageContainers(rows, current);
  if (stale.length === 0) return;
  console.log(`infra: recreating ${stale.map((r) => r.name).join(", ")} and their dependents (image rebuilt)`);
  // Volumes are kept; compose's `up -d` creates the containers again from the new images.
  const rm = Bun.spawnSync(["podman", "rm", "-f", "--depend", "-t", "10", ...stale.map((r) => r.name)], {
    stdio: ["inherit", "inherit", "inherit"],
    timeout: 120_000,
  });
  if (rm.exitCode !== 0) throw new Error(`could not remove stale containers (${rm.exitCode})`);
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

/**
 * Throwaway containers, compose projects (`commonair-it-*` containers, volumes, network) and
 * databases that integration tests create. A killed run skips its cleanup and leaks them, and the
 * leaked stacks keep running and load every later run.
 */
const TEST_RESOURCE =
  /^(?:(?:harness-mediamtx|media-int-(?:garage|mtx|target)|origin-test)-[0-9a-f]{8}|commonair-it-[0-9a-f]{8}[_-][\w.-]+)$/;
/** Far longer than any test run, so another checkout's run in progress is never touched. */
export const STALE_TEST_MS = 2 * 60 * 60_000;

export interface TestResource {
  kind: "container" | "volume" | "network";
  name: string;
  createdMs: number;
}

export function staleTestResources(rows: TestResource[], now: number): TestResource[] {
  // An unparseable creation time is NaN, which is never stale.
  return rows.filter((r) => TEST_RESOURCE.test(r.name) && now - r.createdMs > STALE_TEST_MS);
}

function podmanJson<T>(args: string[]): T[] {
  const p = Bun.spawnSync(["podman", ...args, "--format", "json"], { timeout: 30_000 });
  try {
    return (JSON.parse(p.stdout.toString() || "[]") as T[] | null) ?? [];
  } catch {
    return [];
  }
}

function testResources(): TestResource[] {
  return [
    ...podmanJson<{ Names?: string[]; Created?: number }>(["ps", "-a"]).map((c) => ({
      kind: "container" as const,
      name: c.Names?.[0] ?? "",
      createdMs: (c.Created ?? Number.NaN) * 1000,
    })),
    ...podmanJson<{ Name?: string; CreatedAt?: string }>(["volume", "ls"]).map((v) => ({
      kind: "volume" as const,
      name: v.Name ?? "",
      createdMs: Date.parse(v.CreatedAt ?? ""),
    })),
    ...podmanJson<{ name?: string; created?: string }>(["network", "ls"]).map((n) => ({
      kind: "network" as const,
      name: n.name ?? "",
      createdMs: Date.parse(n.created ?? ""),
    })),
  ];
}

/** Superuser SQL inside the stack's Postgres container (the app role cannot drop databases). */
function psql(sql: string): string {
  const id = containerId("postgres");
  if (!id) throw new Error("postgres container not found");
  const p = Bun.spawnSync(
    ["podman", "exec", id, "sh", "-c", 'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -Atc "$1"', "sh", sql],
    { timeout: 60_000 },
  );
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim());
  return p.stdout.toString().trim();
}

function sweepStaleTestContainers(): void {
  try {
    const stale = staleTestResources(testResources(), Date.now());
    const names = (kind: TestResource["kind"]) => stale.filter((r) => r.kind === kind).map((r) => r.name);
    // Containers first: volumes and networks in use cannot be removed. --depend because compose's
    // depends_on makes podman refuse to remove a container before its dependents.
    for (const [kind, cmd] of [
      ["container", ["rm", "-f", "--depend", "-t", "1"]],
      ["volume", ["volume", "rm", "-f"]],
      ["network", ["network", "rm", "-f"]],
    ] as const) {
      const list = names(kind);
      if (list.length > 0) Bun.spawnSync(["podman", ...cmd, ...list], { timeout: 120_000 });
    }
    if (stale.length > 0) console.log(`infra: removed ${stale.length} stale test containers, volumes and networks`);
  } catch (e) {
    console.warn(`infra: stale test container sweep skipped: ${(e as Error).message}`);
  }
}

function sweepStaleTestDatabases(): void {
  try {
    // PG_VERSION is written when a database is created, so its mtime is the database's age.
    // %I quotes the name server-side, so no database name can inject SQL into the drop.
    const stale = psql(
      `select format('drop database if exists %I with (force)', datname) from pg_database d ` +
        `where datname like 'commonair\\_test\\_%' ` +
        `and (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification < now() - interval '${STALE_TEST_MS / 1000} seconds' ` +
        `and not exists (select 1 from pg_stat_activity a where a.datid = d.oid)`,
    )
      .split("\n")
      .filter(Boolean);
    for (const drop of stale) psql(drop);
    if (stale.length > 0) console.log(`infra: dropped ${stale.length} stale test databases`);
  } catch (e) {
    console.warn(`infra: stale test database sweep skipped: ${(e as Error).message}`);
  }
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

/** `-f` arguments for `stack`: none for the plain stack, else compose.yaml plus each override. */
export function stackFiles(overrides: readonly string[]): string[] {
  if (overrides.length === 0) return [];
  for (const o of overrides) {
    if (o.startsWith("-")) throw new Error(`unknown option ${o}; stack takes override file paths`);
    if (!existsSync(resolve(ROOT, o))) throw new Error(`override file not found: ${o}`);
  }
  return ["compose.yaml", ...overrides].flatMap((f) => ["-f", resolve(ROOT, f)]);
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
      sweepStaleTestContainers();
      compose(["build", ...BUILD_SERVICES], 20 * 60_000);
      composeUp(["up", "-d", ...TEST_SERVICES], 5 * 60_000);
      await waitHealthy(HEALTHY_SERVICES);
      await waitExited(ONE_SHOT_SERVICES);
      sweepStaleTestDatabases();
      console.log(`infra: ${TEST_SERVICES.join(", ")} healthy`);
    } else if (cmd === "stack") {
      preflight();
      const files = stackFiles(process.argv.slice(3));
      compose([...files, "--profile", "harness", "build"], 20 * 60_000);
      removeStaleImageContainers();
      composeUp([...files, "--profile", "harness", "up", "-d"], 10 * 60_000);
      await waitExited(ONE_SHOT_SERVICES);
      await waitHealthy(STACK_HEALTHY_SERVICES, 300_000);
      console.log("infra: platform healthy");
    } else if (cmd === "down") {
      compose(["down"], 5 * 60_000);
    } else if (cmd === "reset") {
      compose(["down", "-v"], 5 * 60_000);
    } else {
      console.error("usage: bun scripts/infra.ts test | stack [override.yaml...] | down | reset");
      process.exit(2);
    }
  } catch (e) {
    console.error(`infra: ${(e as Error).message}`);
    process.exit(1);
  }
}
