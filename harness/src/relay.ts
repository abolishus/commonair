// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Go member relay as the harness runs it (docs/testing/e3-selectors.md, "Running a relay
 * locally"): built from `relay/` with `go build` into a temp dir cached by a hash of its sources,
 * started on the host with a LAN `--public-url` (the API container health-checks it, so
 * `localhost` would point at the container itself), logs captured for the report, `/healthz`
 * waited for, and stopped with SIGTERM so it sends its draining heartbeat.
 */
import type { Logger } from "@commonair/observability";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Supervised, spawnSupervised } from "./process.ts";
import { waitFor } from "./wait.ts";

export const RELAY_DIR = fileURLToPath(new URL("../../relay", import.meta.url));
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** SIGTERM drain (30 s default) + final receipt window (10 s) + slack. */
export const RELAY_STOP_GRACE_MS = 60_000;

// LAN address ------------------------------------------------------------------------------

/**
 * First non-internal IPv4 address, in interface order. Link-local 169.254/16 addresses are skipped:
 * they exist when DHCP failed and nothing else (the API container) can reach them.
 */
export function pickLanIPv4(interfaces: Record<string, NetworkInterfaceInfo[] | undefined>): string | null {
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      // Node < 18.4 reported family as a number.
      const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
      if (v4 && !a.internal && !a.address.startsWith("169.254.")) return a.address;
    }
  }
  return null;
}

/** The relay host: `--set relayHost` when given, else the detected LAN IPv4 (clear error if none). */
export function relayHost(override: string | undefined, interfaces = networkInterfaces()): string {
  if (override) return override;
  const found = pickLanIPv4(interfaces);
  if (!found)
    throw new Error(
      "no LAN IPv4 address found for the relay's --public-url (the API container must reach it; localhost would be the container itself). Pass --set relayHost=<address>",
    );
  return found;
}

/** A TCP port free on all interfaces right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error("could not get a free port"))));
    });
  });
}

// Readiness ------------------------------------------------------------------------------

/** Minimal `.env` reader (KEY=value, optional quotes, `#` comments): enough for one flag. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    let value = (m[2] ?? "").trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]] = value;
  }
  return out;
}

/**
 * Why the API would refuse a LAN relay URL, or null. The stack's settings come from the process
 * env (Bun loads the repo `.env` when the harness runs from the repo root, like `DATABASE_URL`)
 * and otherwise from the repo `.env` file the compose stack reads.
 */
export function privateNetworksProblem(
  env: Record<string, string | undefined>,
  dotenv: Record<string, string> | null,
): string | null {
  const value = env.OUTBOUND_ALLOW_PRIVATE_NETWORKS ?? dotenv?.OUTBOUND_ALLOW_PRIVATE_NETWORKS;
  if (value !== undefined && ["true", "1"].includes(value.trim().toLowerCase())) return null;
  return `OUTBOUND_ALLOW_PRIVATE_NETWORKS is ${value === undefined ? "unset" : `"${value}"`}: the API refuses http and private-network relay URLs. Set OUTBOUND_ALLOW_PRIVATE_NETWORKS=true in .env and restart the API (bun scripts/infra.ts stack)`;
}

export function readRepoDotenv(root = REPO_ROOT): Record<string, string> | null {
  const file = join(root, ".env");
  return existsSync(file) ? parseDotenv(readFileSync(file, "utf8")) : null;
}

/** `go version` output, or null when Go is not installed. */
export async function goVersion(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["go", "version"], { stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

/** The `relay` need: sources present, Go installed, the API accepting LAN relays. Null when met. */
export async function relayReadiness(
  env: Record<string, string | undefined> = process.env,
  dotenv: Record<string, string> | null = readRepoDotenv(),
  apiHealth: () => Promise<Record<string, unknown> | null> = () => fetchApiHealth(env),
): Promise<string | null> {
  if (!existsSync(join(RELAY_DIR, "go.mod"))) return "relay sources not present";
  if (!(await goVersion())) return "Go toolchain not found (`go version` failed): install Go to build relay/";
  // The running API knows its own setting (compose overrides set it without touching `.env`).
  const health = await apiHealth();
  if (typeof health?.outboundPrivateNetworks === "boolean")
    return health.outboundPrivateNetworks
      ? null
      : privateNetworksProblem({ OUTBOUND_ALLOW_PRIVATE_NETWORKS: "false" }, null);
  return privateNetworksProblem(env, dotenv);
}

async function fetchApiHealth(env: Record<string, string | undefined>): Promise<Record<string, unknown> | null> {
  const base = env.HARNESS_API_URL ?? "http://localhost:3001";
  try {
    const res = await fetch(new URL("/healthz", base), { signal: AbortSignal.timeout(3_000) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Build ----------------------------------------------------------------------------------

/** Files that determine the binary: Go sources, go.mod and go.sum (tests excluded). */
export function relaySourceFiles(dir = RELAY_DIR): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        if (!name.startsWith(".") && name !== "testdata") walk(full);
      } else if ((name.endsWith(".go") && !name.endsWith("_test.go")) || name === "go.mod" || name === "go.sum") {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/** Hash of relative paths and contents; changes whenever the build input changes. */
export function relaySourceHash(dir = RELAY_DIR): string {
  const h = createHash("sha256");
  for (const file of relaySourceFiles(dir)) {
    h.update(relative(dir, file));
    h.update("\0");
    h.update(readFileSync(file));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** Build `cmd/commonair-relay` once per source hash; returns the binary path. */
export async function buildRelay(opts: { dir?: string; cacheDir?: string; log?: Logger } = {}): Promise<string> {
  const dir = opts.dir ?? RELAY_DIR;
  const hash = relaySourceHash(dir);
  const outDir = join(opts.cacheDir ?? join(tmpdir(), "commonair-harness-relay"), hash);
  const binary = join(outDir, "commonair-relay");
  if (existsSync(binary)) {
    opts.log?.info("relay binary cached", { hash });
    return binary;
  }
  mkdirSync(outDir, { recursive: true });
  const tmp = `${binary}.${process.pid}.tmp`;
  opts.log?.info("building the relay", { hash });
  const proc = Bun.spawn(
    ["go", "build", "-o", tmp, "-ldflags", `-X main.version=harness-${hash}`, "./cmd/commonair-relay"],
    {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`go build failed (exit ${code}): ${stderr.trim().slice(-2_000)}`);
  // Rename is atomic: a concurrent run never sees a half-written binary.
  renameSync(tmp, binary);
  return binary;
}

// Process --------------------------------------------------------------------------------

export interface RelayLaunch {
  binary: string;
  /** Instance API base the relay registers with. */
  api: string;
  host: string;
  port: number;
  dataDir: string;
  capacityMbps?: number;
}

/**
 * Argv from the e3-selectors recipe. The token goes in `COMMONAIR_RELAY_TOKEN` instead of
 * `--token` (the relay's own advice) so it never shows in `ps` or the report.
 */
export function relayArgv(l: RelayLaunch): string[] {
  return [
    l.binary,
    "--api",
    l.api,
    "--public-url",
    `http://${l.host}:${l.port}`,
    "--listen",
    `:${l.port}`,
    "--data-dir",
    l.dataDir,
    "--capacity-mbps",
    String(l.capacityMbps ?? 1000),
  ];
}

/** `/healthz` body (relay/internal/server Health). */
export interface RelayHealth {
  status: string;
  version: string;
  viewers: number;
}

/** Bounded log of a child's output lines with timestamps, for the scenario report. */
export class LineLog {
  private readonly items: string[] = [];
  constructor(private readonly max = 2_000) {}
  push(stream: string, line: string): void {
    this.items.push(`${new Date().toISOString()} ${stream} ${line}`);
    if (this.items.length > this.max) this.items.shift();
  }
  lines(tail?: number): string[] {
    return tail === undefined ? [...this.items] : this.items.slice(-tail);
  }
}

/** A running Go relay. `start()` again after `terminate()` restarts it with the same key and token. */
export class GoRelay {
  readonly logs = new LineLog();
  private proc: Supervised | null = null;
  private starts = 0;

  constructor(
    private readonly launch: RelayLaunch & { token: string },
    private readonly log?: Logger,
  ) {}

  get url(): string {
    return `http://${this.launch.host}:${this.launch.port}`;
  }

  get running(): boolean {
    return this.proc?.running ?? false;
  }

  start(): void {
    if (this.proc?.running) throw new Error("relay already running");
    this.starts++;
    const run = this.starts;
    this.logs.push("harness", `start #${run}`);
    this.proc = spawnSupervised(relayArgv(this.launch), {
      name: `relay-${run}`,
      env: { COMMONAIR_RELAY_TOKEN: this.launch.token },
      stopSignal: "SIGTERM",
      onStdoutLine: (line) => this.logs.push("stdout", line),
      onStderrLine: (line) => this.logs.push("stderr", line),
    });
    void this.proc.exited.then((code) => this.logs.push("harness", `exit #${run} code ${code}`));
  }

  async health(): Promise<RelayHealth | null> {
    try {
      const res = await fetch(`${this.url}/healthz`, { signal: AbortSignal.timeout(2_000) });
      return (await res.json()) as RelayHealth;
    } catch {
      return null;
    }
  }

  /** Wait for `/healthz` to answer 200 (`starting` before registration, then `ok`). */
  async waitHealthy(timeoutMs = 30_000, signal?: AbortSignal): Promise<RelayHealth> {
    return waitFor(
      "relay /healthz",
      async () => {
        if (this.proc && !this.proc.running) throw new Error(`relay exited: ${this.logs.lines(5).join(" | ")}`);
        const res = await fetch(`${this.url}/healthz`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
        return res?.ok ? ((await res.json()) as RelayHealth) : null;
      },
      { timeoutMs, intervalMs: 250, signal },
    );
  }

  /** SIGTERM (the relay drains and sends `draining: true`), SIGKILL after the grace. Resolves on exit. */
  terminate(graceMs = RELAY_STOP_GRACE_MS): Promise<number> {
    const p = this.proc;
    if (!p) return Promise.resolve(0);
    this.logs.push("harness", "SIGTERM");
    return p.stop(graceMs);
  }

  /** Teardown: always safe to call. */
  async stop(): Promise<void> {
    if (this.proc?.running)
      await this.terminate().catch((err: unknown) => this.log?.warn("relay stop failed", { error: String(err) }));
  }
}
