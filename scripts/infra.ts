// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local infrastructure helper around `podman compose`.
 *
 *   bun scripts/infra.ts test   start the data services integration tests need, wait for health
 *   bun scripts/infra.ts stack [--harness] [override.yaml...]
 *                               build and start the whole platform (+ harness profile), wait for health;
 *                               override files are layered over compose.yaml (e.g.
 *                               harness/compose.trust-safety.yaml for the `trust-safety` scenario);
 *                               --multi (with --harness) also starts the `multi` replicas
 *                               (api-2, chat-2, worker-2, origin-2) for `multi-instance`
 *   bun scripts/infra.ts down   stop everything (volumes kept)
 *   bun scripts/infra.ts reset  stop everything and delete volumes
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pidAlive, TEST_OWNER_LABEL, testOwnerPid } from "./test-owner.ts";

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
  "tracker",
  // STUN for P2P playback; its healthcheck is a binding request to itself (turnutils_stunclient).
  "coturn",
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

function staleProjectContainers(): ImageRow[] {
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
  return staleImageContainers(rows, current);
}

function removeStaleImageContainers(): void {
  const stale = staleProjectContainers();
  if (stale.length === 0) return;
  console.log(`infra: recreating ${stale.map((r) => r.name).join(", ")} and their dependents (image rebuilt)`);
  // Volumes are kept; compose's `up -d` creates the containers again from the new images.
  const rm = Bun.spawnSync(["podman", "rm", "-f", "--depend", "-t", "10", ...stale.map((r) => r.name)], {
    stdio: ["inherit", "inherit", "inherit"],
    timeout: 120_000,
  });
  if (rm.exitCode !== 0) throw new Error(`could not remove stale containers (${rm.exitCode})`);
  // podman's `rm --depend` can remove a one-shot container's dependents yet keep the container
  // itself (migrate, garage-init), and compose then restarts the old one: remove survivors by id.
  for (const r of staleProjectContainers()) {
    const id = Bun.spawnSync(["podman", "inspect", "--format", "{{.Id}}", r.name], { timeout: 30_000 });
    const target = id.exitCode === 0 ? id.stdout.toString().trim() : r.name;
    Bun.spawnSync(["podman", "rm", "-f", "--depend", "-t", "10", target], { timeout: 60_000 });
    const one = Bun.spawnSync(["podman", "rm", "-f", "--ignore", "-t", "10", target], {
      stdio: ["inherit", "inherit", "inherit"],
      timeout: 60_000,
    });
    if (one.exitCode !== 0) throw new Error(`could not remove stale container ${r.name} (${one.exitCode})`);
  }
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
 * Throwaway containers, compose projects (`commonair-it-*` containers, volumes, network), images
 * and databases that integration tests create. A killed run skips its cleanup and leaks them, and
 * the leaked stacks keep running and load every later run. Resources labelled with their owner
 * (`test-owner.ts`) go as soon as that process is gone; older unlabelled ones by name and age.
 */
const TEST_RESOURCE =
  /^(?:(?:harness-mediamtx(?:-ff)?|media-int-[a-z]+|origin-test|commonair-pgh(?:-[a-z]+)?)-[0-9a-f]{8}|commonair-it-(?:\d+-)?[0-9a-f]{8}[_-][\w.-]+)$/;
/** Far longer than any test run, so another checkout's run in progress is never touched. */
export const STALE_TEST_MS = 2 * 60 * 60_000;

export interface TestResource {
  kind: "container" | "volume" | "network" | "image";
  name: string;
  createdMs: number;
  labels?: Record<string, string> | null;
}

/** Test resources to remove: those whose owner process is gone, and old unlabelled ones by name. */
export function staleTestResources(
  rows: TestResource[],
  now: number,
  alive: (pid: number) => boolean = pidAlive,
): TestResource[] {
  return rows.filter((r) => {
    const owner = testOwnerPid(r.labels);
    if (owner !== undefined) return !alive(owner);
    // An unparseable creation time is NaN, which is never stale.
    return r.kind !== "image" && TEST_RESOURCE.test(r.name) && now - r.createdMs > STALE_TEST_MS;
  });
}

function podmanJson<T>(args: string[]): T[] {
  const p = Bun.spawnSync(["podman", ...args, "--format", "json"], { timeout: 30_000 });
  try {
    return (JSON.parse(p.stdout.toString() || "[]") as T[] | null) ?? [];
  } catch {
    return [];
  }
}

type Labels = Record<string, string> | null;

function testResources(): TestResource[] {
  return [
    ...podmanJson<{ Names?: string[]; Created?: number; Labels?: Labels }>(["ps", "-a"]).map((c) => ({
      kind: "container" as const,
      name: c.Names?.[0] ?? "",
      createdMs: (c.Created ?? Number.NaN) * 1000,
      labels: c.Labels,
    })),
    ...podmanJson<{ Name?: string; CreatedAt?: string; Labels?: Labels }>(["volume", "ls"]).map((v) => ({
      kind: "volume" as const,
      name: v.Name ?? "",
      createdMs: Date.parse(v.CreatedAt ?? ""),
      labels: v.Labels,
    })),
    ...podmanJson<{ name?: string; created?: string; labels?: Labels }>(["network", "ls"]).map((n) => ({
      kind: "network" as const,
      name: n.name ?? "",
      createdMs: Date.parse(n.created ?? ""),
      labels: n.labels,
    })),
    // Only labelled images: an image's name says nothing about who built it.
    ...podmanJson<{ Id?: string; Created?: number; Labels?: Labels }>([
      "images",
      "--filter",
      `label=${TEST_OWNER_LABEL}`,
    ]).map((i) => ({
      kind: "image" as const,
      name: i.Id ?? "",
      createdMs: (i.Created ?? Number.NaN) * 1000,
      labels: i.Labels,
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
      ["image", ["rmi", "-f"]],
    ] as const) {
      const list = names(kind);
      if (list.length > 0) Bun.spawnSync(["podman", ...cmd, ...list], { timeout: 120_000 });
    }
    if (stale.length > 0)
      console.log(`infra: removed ${stale.length} leftover test containers, volumes, networks and images`);
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

/**
 * Podman Desktop polls the API service so often that it pegs the VM's CPU and slows every
 * timing-sensitive test. Matches the app's main process only, not its helpers.
 */
export function podmanDesktopRunning(psOutput: string): boolean {
  return psOutput.split("\n").some((l) => l.trim().endsWith("/Contents/MacOS/Podman Desktop"));
}

function warnPodmanDesktop(): void {
  if (process.platform !== "darwin") return;
  const ps = Bun.spawnSync(["ps", "-axo", "comm="], { timeout: 10_000 });
  if (podmanDesktopRunning(ps.stdout.toString()))
    console.warn(
      "infra: Podman Desktop is running; its polling loads the podman VM and makes timing tests flaky. Quit it for test runs.",
    );
}

function preflight(): void {
  warnPodmanDesktop();
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

/**
 * The harness stack (ADR 0021): every harness override, layered in this order. `full` runs on it.
 * Its Postgres volume must have been created with the E5 bootstrap (ADR 0020).
 */
export const HARNESS_OVERRIDES = [
  "harness/compose.trust-safety.yaml",
  "harness/compose.e5-coop.yaml",
  "harness/compose.e6.yaml",
  "harness/compose.p2p.yaml",
  "harness/compose.e8.yaml",
  "harness/compose.e9.yaml",
  "harness/compose.w1.yaml",
  "harness/compose.n1.yaml",
  // Starts nothing unless the `multi` profile is on (`stack --harness --multi`).
  "harness/compose.multi-instance.yaml",
] as const;

/** The `multi` profile's replicas (harness/compose.multi-instance.yaml, scenario `multi-instance`). */
export const MULTI_REPLICAS = ["api-2", "chat-2", "worker-2", "origin-2"];

/** Compose profiles `stack` enables: `harness` always, `multi` with `--multi` (needs `--harness`). */
export function stackProfiles(args: readonly string[]): string[] {
  if (!args.includes("--multi")) return ["harness"];
  if (!args.includes("--harness")) throw new Error("--multi needs --harness (the replicas are a harness override)");
  return ["harness", "multi"];
}

/** `-f` arguments for `stack`: none for the plain stack, else compose.yaml plus each override. */
export function stackFiles(args: readonly string[]): string[] {
  const rest = args.filter((a) => a !== "--harness" && a !== "--multi");
  const overrides = args.includes("--harness") ? [...HARNESS_OVERRIDES, ...rest] : rest;
  if (overrides.length === 0) return [];
  for (const o of overrides) {
    if (o.startsWith("-")) throw new Error(`unknown option ${o}; stack takes override file paths`);
    if (!existsSync(resolve(ROOT, o))) throw new Error(`override file not found: ${o}`);
  }
  return ["compose.yaml", ...overrides].flatMap((f) => ["-f", resolve(ROOT, f)]);
}

type Condition = "service_started" | "service_healthy" | "service_completed_successfully";
export interface ComposeService {
  profiles?: string[];
  depends_on?: string[] | Record<string, { condition?: Condition }>;
}

function dependsOn(svc: ComposeService): Record<string, Condition> {
  const d = svc.depends_on ?? {};
  if (Array.isArray(d)) return Object.fromEntries(d.map((n) => [n, "service_started" as const]));
  return Object.fromEntries(Object.entries(d).map(([n, v]) => [n, v.condition ?? "service_started"]));
}

/**
 * How `stack` starts the platform. Podman 4.9 (Ubuntu 24.04, so CI) cannot `podman start` a
 * container whose `--requires` chain passes an exited one-shot that itself requires a running
 * container ("generating dependency graph … not found in input list"): its dependency walk
 * skips running containers. So `first` (everything not behind a one-shot) goes up as usual, and
 * the services behind `migrate`/`garage-init` follow in dependency waves with `--no-deps`, which
 * creates them without `--requires`; `stack` waits for each wave's conditions itself.
 */
export function startPlan(
  services: Record<string, ComposeService>,
  profiles: ReadonlySet<string>,
  oneShots: readonly string[],
): { first: string[]; waves: { services: string[]; wait: Record<string, Condition> }[] } {
  const enabled = Object.keys(services).filter((n) => {
    const p = services[n]?.profiles ?? [];
    return p.length === 0 || p.some((x) => profiles.has(x));
  });
  const deps = new Map(
    enabled.map((n) => [n, Object.entries(dependsOn(services[n] ?? {})).filter(([d]) => enabled.includes(d))]),
  );
  // Behind a one-shot: depends on one, or on a service that is.
  const later = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const n of enabled)
      if (!later.has(n) && (deps.get(n) ?? []).some(([d]) => oneShots.includes(d) || later.has(d))) {
        later.add(n);
        grew = true;
      }
  }
  const waves: { services: string[]; wait: Record<string, Condition> }[] = [];
  const placed = new Set<string>();
  while (placed.size < later.size) {
    const wave = [...later].filter(
      (n) => !placed.has(n) && (deps.get(n) ?? []).every(([d]) => !later.has(d) || placed.has(d)),
    );
    if (wave.length === 0)
      throw new Error(`depends_on cycle among ${[...later].filter((n) => !placed.has(n)).join(", ")}`);
    const wait: Record<string, Condition> = {};
    for (const n of wave) for (const [d, c] of deps.get(n) ?? []) if (wait[d] !== "service_healthy") wait[d] = c;
    waves.push({ services: wave.sort(), wait });
    for (const n of wave) placed.add(n);
  }
  return { first: enabled.filter((n) => !later.has(n)), waves };
}

/** The merged compose configuration `stack` starts (after overrides). */
function composeConfig(files: string[], profileArgs: string[]): Record<string, ComposeService> {
  const proc = Bun.spawnSync(["podman", "compose", ...files, ...profileArgs, "config"], {
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`podman compose config failed:\n${proc.stderr.toString()}`);
  // The provider banner ("Executing external compose provider…") goes to stderr; stdout is YAML.
  const parsed = Bun.YAML.parse(proc.stdout.toString()) as { services?: Record<string, ComposeService> };
  return parsed.services ?? {};
}

/** `down` reads compose.yaml alone, which does not know the `multi` replicas: remove them first. */
function removeReplicas(): void {
  const names = projectContainers()
    .filter((r) => MULTI_REPLICAS.includes(r.service))
    .map((r) => r.name);
  if (names.length > 0) Bun.spawnSync(["podman", "rm", "-f", ...names], { timeout: 60_000 });
}

async function waitConditions(wait: Record<string, Condition>): Promise<void> {
  const of = (c: Condition) => Object.keys(wait).filter((s) => wait[s] === c);
  await waitExited(of("service_completed_successfully"));
  await waitHealthy(of("service_healthy"), 300_000);
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

/**
 * In-network DNS (aardvark-dns, Podman 4.9.3 on Ubuntu 24.04, so CI) stops answering while
 * containers join the network: a probe on the compose network saw every name time out for ~40 s
 * after the app wave started. When that outlasted the healthchecks (which can pass on pooled
 * connections), "platform healthy" was printed while the API still could not resolve `mailpit`,
 * and the first sign-up's verification mail was lost. So before declaring the platform healthy,
 * wait until every service name resolves promptly for a while. The probe runs with `podman exec`
 * in a running service: a probe container would itself join and leave the network.
 */
export const DNS_SETTLED_ROUNDS = 10;
const DNS_SETTLE_TIMEOUT_MS = 4 * 60_000;

/**
 * One round a second, each name through c-ares straight to the network's resolver (1 s, no
 * retries, so a stalled resolver shows at once); exits 0 after `rounds` clean rounds in a row,
 * 1 at the deadline. Prints each bad round and a summary.
 */
export function dnsSettleScript(hosts: readonly string[], rounds: number, timeoutMs: number): string {
  return `
const { Resolver } = require("node:dns").promises;
const hosts = ${JSON.stringify(hosts)};
const deadline = Date.now() + ${timeoutMs};
let streak = 0, bad = 0;
while (streak < ${rounds}) {
  if (Date.now() > deadline) { console.log("dns: not settled; " + bad + " bad rounds"); process.exit(1); }
  const started = Date.now();
  const failed = (await Promise.all(hosts.map((h) =>
    new Resolver({ timeout: 1000, tries: 1 }).resolve4(h).then(() => null, (e) => h + "=" + (e.code || e.message))))).filter(Boolean);
  if (failed.length) { streak = 0; bad++; console.log(new Date().toISOString() + " dns: " + failed.join(" ")); }
  else streak++;
  await Bun.sleep(Math.max(0, 1000 - (Date.now() - started)));
}
console.log("dns: " + hosts.length + " names settled after " + bad + " bad rounds");
`;
}

/** Waits for in-network DNS to answer `hosts` steadily, probing from inside `fromService`. */
function waitDnsSettled(fromService: string, hosts: readonly string[]): void {
  const id = containerId(fromService);
  if (!id) throw new Error(`no ${fromService} container to probe in-network DNS from`);
  const proc = Bun.spawnSync(
    ["podman", "exec", id, "bun", "-e", dnsSettleScript(hosts, DNS_SETTLED_ROUNDS, DNS_SETTLE_TIMEOUT_MS)],
    { stdio: ["ignore", "inherit", "inherit"], timeout: DNS_SETTLE_TIMEOUT_MS + 60_000, killSignal: "SIGKILL" },
  );
  if (proc.exitCode !== 0) throw new Error(`in-network DNS did not settle; see the dns: lines above`);
}

if (import.meta.main) {
  try {
    const cmd = process.argv[2];
    if (cmd === "test") {
      preflight();
      sweepStaleTestContainers();
      // Overrides as for `stack`: a gate that runs harness scenarios next passes --harness, so the
      // first migration of a fresh volume already seeds the harness's governance bootstrap.
      const files = stackFiles(process.argv.slice(3));
      compose([...files, "build", ...BUILD_SERVICES], 20 * 60_000);
      composeUp([...files, "up", "-d", ...TEST_SERVICES], 5 * 60_000);
      await waitHealthy(HEALTHY_SERVICES);
      await waitExited(ONE_SHOT_SERVICES);
      sweepStaleTestDatabases();
      console.log(`infra: ${TEST_SERVICES.join(", ")} healthy`);
    } else if (cmd === "stack") {
      preflight();
      const files = stackFiles(process.argv.slice(3));
      const profiles = stackProfiles(process.argv.slice(3));
      const profileArgs = profiles.flatMap((p) => ["--profile", p]);
      compose([...files, ...profileArgs, "build"], 20 * 60_000);
      removeStaleImageContainers();
      const plan = startPlan(composeConfig(files, profileArgs), new Set(profiles), ONE_SHOT_SERVICES);
      composeUp([...files, ...profileArgs, "up", "-d", ...plan.first], 10 * 60_000);
      await waitExited(ONE_SHOT_SERVICES);
      for (const wave of plan.waves) {
        await waitConditions(wave.wait);
        composeUp([...files, ...profileArgs, "up", "-d", "--no-deps", ...wave.services], 10 * 60_000);
      }
      // podman can keep a one-shot container (migrate) whose dependents block its removal, and
      // compose then reuses it: the stack would run without the new migrations. Fail loudly.
      const still = staleProjectContainers();
      if (still.length > 0)
        throw new Error(
          `still on an old image: ${still.map((r) => r.name).join(", ")}; ` +
            `run \`podman rm -f --depend ${still.map((r) => r.name).join(" ")}\` and \`stack\` again`,
        );
      const running = profiles.includes("multi")
        ? [...STACK_HEALTHY_SERVICES, ...MULTI_REPLICAS]
        : STACK_HEALTHY_SERVICES;
      await waitHealthy(running, 300_000);
      waitDnsSettled("api", running);
      console.log("infra: platform healthy");
    } else if (cmd === "down") {
      removeReplicas();
      compose(["down"], 5 * 60_000);
    } else if (cmd === "reset") {
      removeReplicas();
      compose(["down", "-v"], 5 * 60_000);
    } else {
      console.error(
        "usage: bun scripts/infra.ts test [--harness] [override.yaml...] | stack [--harness [--multi]] [override.yaml...] | down | reset",
      );
      process.exit(2);
    }
  } catch (e) {
    console.error(`infra: ${(e as Error).message}`);
    process.exit(1);
  }
}
