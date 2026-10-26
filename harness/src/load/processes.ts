// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The processes that drive shards of the HTTP audience: a local child (`bun load/worker.ts`, the
 * default) or the same worker on another generator host over SSH, selected by
 * `HARNESS_LOAD_GENERATOR_HOSTS`. Both speak the `LOAD_SHARD` line protocol on stdout
 * (`shard.ts`); the remote one is stopped by closing its stdin, which a small shell wrapper on
 * the far side turns into SIGINT for the worker (ssh does not forward signals).
 */
import { fileURLToPath } from "node:url";
import { type Supervised, spawnSupervised } from "../process.ts";
import type { ViewerReport } from "../viewer.ts";
import { withTimeout } from "./async.ts";
import { SHARD_EXIT_DRAIN_MS, ShardLink, type WorkerSpec } from "./shard.ts";
import { shellQuote, sshArgv } from "./ssh.ts";

export const WORKER_ENTRY = fileURLToPath(new URL("./worker.ts", import.meta.url));
/** The worker relative to the repository root, for remote hosts with their own checkout. */
export const WORKER_RELATIVE = "harness/src/load/worker.ts";
/** This checkout's root: the default checkout path on generator hosts. */
export const LOCAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const SHARD_STOP_GRACE_MS = 90_000;

/** The generator-host list entry that means "a child process on this machine". */
export const LOCAL_HOST = "local";

export interface ShardHandle {
  readonly index: number;
  /** `local` or the SSH destination. */
  readonly host: string;
  waitStarted(timeoutMs: number): Promise<number>;
  stop(): Promise<ViewerReport[]>;
  kill(): Promise<unknown>;
}

/** The host for each shard: the list dealt round-robin, or every shard local without one. Pure. */
export function assignShardHosts(shards: number, hosts: readonly string[]): string[] {
  if (!Number.isInteger(shards) || shards < 0) throw new RangeError("shards must be a non-negative integer");
  const list = hosts.map((h) => h.trim()).filter(Boolean);
  return Array.from({ length: shards }, (_, i) => (list.length === 0 ? LOCAL_HOST : (list[i % list.length] as string)));
}

/**
 * Variables a remote worker needs to reach the instance. Only these cross to the other host (no
 * Mailpit credentials, no secrets); the rest come from that checkout's own environment.
 */
export const FORWARDED_ENV_KEYS = [
  "HARNESS_API_URL",
  "HARNESS_WEB_URL",
  "HARNESS_ORIGIN_URL",
  "HARNESS_PLAYER",
  "HARNESS_RESIDENTIAL_CIDRS_FILE",
  "LOG_LEVEL",
] as const;

export function forwardedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FORWARDED_ENV_KEYS) {
    const v = env[k];
    if (v !== undefined && v.trim() !== "") out[k] = v;
  }
  return out;
}

/**
 * The remote command: run the worker in the background, wait for stdin to close (the parent's
 * stop, or ssh going away), SIGINT the worker and exit with its code. Pure.
 */
export function remoteWorkerCommand(repo: string, worker: WorkerSpec, env: Readonly<Record<string, string>>): string {
  return `sh -c ${shellQuote(remoteWorkerScript(repo, worker, env))}`;
}

/** The script `remoteWorkerCommand` runs; `workerCommand` is replaceable for tests. Pure. */
export function remoteWorkerScript(
  repo: string,
  worker: WorkerSpec,
  env: Readonly<Record<string, string>>,
  workerCommand = `bun ${WORKER_RELATIVE}`,
): string {
  const vars = Object.entries(env)
    .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  return [
    `cd ${shellQuote(repo)} || exit 97`,
    `PATH="$HOME/.bun/bin:$PATH"; export PATH`,
    `env ${vars} ${workerCommand} ${shellQuote(JSON.stringify(worker))} & pid=$!`,
    `cat >/dev/null`,
    `kill -INT "$pid" 2>/dev/null`,
    `wait "$pid"`,
  ].join("\n");
}

/** A child as the remote shard sees it; `spawnShardChild` is the real one, tests pass a fake. */
export interface ShardChild {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  closeStdin(): void;
  kill(): void;
}

export type ShardSpawner = (argv: string[]) => ShardChild;

export const spawnShardChild: ShardSpawner = (argv) => {
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    closeStdin: () => {
      try {
        void proc.stdin.end();
      } catch {
        // already closed
      }
    },
    kill: () => proc.kill("SIGKILL"),
  };
};

/** Split a byte stream into lines (\n, \r\n or \r), calling `onLine` for each non-empty one. */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n|\r/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.length > 0) onLine(line);
  }
  buffer += decoder.decode();
  if (buffer.length > 0) onLine(buffer);
}

/** A worker on another generator host, over SSH. */
export class RemoteShardProcess implements ShardHandle {
  readonly index: number;
  private readonly link: ShardLink;
  private readonly child: ShardChild;
  private readonly tail: string[] = [];
  private exited = false;
  private readonly stopGraceMs: number;
  private readonly drainMs: number;

  constructor(
    readonly host: string,
    worker: WorkerSpec,
    opts: {
      repo: string;
      env: Readonly<Record<string, string>>;
      spawn?: ShardSpawner;
      drainMs?: number;
      stopGraceMs?: number;
    },
  ) {
    this.index = worker.shard.index;
    this.stopGraceMs = opts.stopGraceMs ?? SHARD_STOP_GRACE_MS;
    this.drainMs = opts.drainMs ?? SHARD_EXIT_DRAIN_MS;
    const link = new ShardLink(this.index, this.drainMs);
    this.link = link;
    this.child = (opts.spawn ?? spawnShardChild)(sshArgv(host, remoteWorkerCommand(opts.repo, worker, opts.env)));
    void readLines(this.child.stdout, (line) => link.onLine(line)).catch(() => undefined);
    void readLines(this.child.stderr, (line) => {
      this.tail.push(line);
      if (this.tail.length > 40) this.tail.shift();
    }).catch(() => undefined);
    void this.child.exited.then((code) => {
      this.exited = true;
      link.onExit(code, () => [`${host}:`, ...this.tail]);
    });
  }

  waitStarted(timeoutMs: number): Promise<number> {
    return withTimeout(this.link.started, timeoutMs, `load shard ${this.index} on ${this.host} start`);
  }

  async stop(): Promise<ViewerReport[]> {
    this.child.closeStdin();
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill();
    }, this.stopGraceMs);
    try {
      return await withTimeout(
        this.link.reports,
        this.stopGraceMs + this.drainMs,
        `load shard ${this.index} on ${this.host} reports`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async kill(): Promise<unknown> {
    this.child.closeStdin();
    if (!this.exited) this.child.kill();
    return this.child.exited;
  }
}

/** A child process on this machine driving one shard (the default). */
export class LocalShardProcess implements ShardHandle {
  readonly host = LOCAL_HOST;
  readonly index: number;
  private proc: Supervised;
  private link: ShardLink;

  constructor(worker: WorkerSpec) {
    this.index = worker.shard.index;
    const link = new ShardLink(worker.shard.index);
    this.link = link;
    this.proc = spawnSupervised(["bun", WORKER_ENTRY, JSON.stringify(worker)], {
      name: `load-shard-${worker.shard.index}`,
      onStdoutLine: (line) => link.onLine(line),
    });
    void this.proc.exited.then((code) => link.onExit(code, () => this.proc.stderr()));
  }

  waitStarted(timeoutMs: number): Promise<number> {
    return withTimeout(this.link.started, timeoutMs, "load shard start");
  }

  async stop(): Promise<ViewerReport[]> {
    if (this.proc.running) void this.proc.stop(SHARD_STOP_GRACE_MS);
    return withTimeout(this.link.reports, SHARD_STOP_GRACE_MS + SHARD_EXIT_DRAIN_MS, "load shard reports");
  }

  kill(): Promise<number> {
    return this.proc.stop(1_000);
  }
}

/** Start one shard on its host. */
export function startShard(
  host: string,
  worker: WorkerSpec,
  remote: { repo: string; env: Readonly<Record<string, string>> },
): ShardHandle {
  return host === LOCAL_HOST ? new LocalShardProcess(worker) : new RemoteShardProcess(host, worker, remote);
}
