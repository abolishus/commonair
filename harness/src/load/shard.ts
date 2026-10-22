// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Spreading HTTP viewers over several harness processes. One Bun process drives a few hundred
 * HTTP viewers comfortably; the PLAN-size run (20 × 200) needs several. The parent keeps the
 * browser viewers and hands each child (`load/worker.ts`) a slice of the HTTP audience; children
 * answer with their viewers' final reports over stdout. Planning and the line protocol are pure.
 */
import type { ViewerReport } from "../viewer.ts";

/** HTTP viewers one process drives by default before the load test shards. */
export const DEFAULT_HTTP_PER_PROCESS = 1_000;

/** Processes needed for `httpViewers` at `perProcess` each (0 when there is nothing to shard). */
export function shardCount(httpViewers: number, perProcess: number): number {
  if (!Number.isInteger(perProcess) || perProcess < 1) throw new RangeError("perProcess must be a positive integer");
  if (httpViewers <= 0) return 0;
  return Math.ceil(httpViewers / perProcess);
}

export interface ShardChannel {
  channel: string;
  http: number;
}

export interface ShardSpec {
  index: number;
  channels: ShardChannel[];
}

/**
 * Split each channel's HTTP viewers over `shards` processes. Viewers are dealt round-robin across
 * the whole audience, so shard totals differ by at most one and every channel is spread.
 */
export function splitShards(perChannel: readonly ShardChannel[], shards: number): ShardSpec[] {
  if (!Number.isInteger(shards) || shards < 1) throw new RangeError("shards must be a positive integer");
  const counts = Array.from({ length: shards }, () => new Map<string, number>());
  let next = 0;
  for (const { channel, http } of perChannel) {
    for (let i = 0; i < http; i++) {
      const m = counts[next % shards] as Map<string, number>;
      m.set(channel, (m.get(channel) ?? 0) + 1);
      next++;
    }
  }
  return counts.map((m, index) => ({ index, channels: [...m].map(([channel, http]) => ({ channel, http })) }));
}

export const shardTotal = (s: ShardSpec): number => s.channels.reduce((n, c) => n + c.http, 0);

/** What the parent passes a child (argv[2], JSON). */
export interface WorkerSpec {
  shard: ShardSpec;
  runId: string;
  /** The child stops on its own after this long, even without a signal. */
  maxMs: number;
}

/** stdout lines of the child protocol start with this; everything else is ignored. */
export const SHARD_LINE_PREFIX = "LOAD_SHARD ";

export type ShardMessage =
  | { type: "started"; shard: number; viewers: number }
  | { type: "reports"; shard: number; reports: ViewerReport[] }
  | { type: "error"; shard: number; error: string };

export function formatShardLine(msg: ShardMessage): string {
  return `${SHARD_LINE_PREFIX}${JSON.stringify(msg)}`;
}

/** Parse one stdout line; null for anything that is not a well-formed protocol message. */
export function parseShardLine(line: string): ShardMessage | null {
  if (!line.startsWith(SHARD_LINE_PREFIX)) return null;
  let v: unknown;
  try {
    v = JSON.parse(line.slice(SHARD_LINE_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.shard !== "number") return null;
  if (m.type === "started" && typeof m.viewers === "number") return m as ShardMessage;
  if (m.type === "reports" && Array.isArray(m.reports)) return m as ShardMessage;
  if (m.type === "error" && typeof m.error === "string") return m as ShardMessage;
  return null;
}

/** Anything with a Node-style `write(chunk, callback)`: process.stdout, or a fake in tests. */
export interface LineSink {
  write(chunk: string, cb: (err?: Error | null) => void): boolean;
}

/**
 * Write one protocol line and resolve once the sink has taken all of it. The reports line runs to
 * megabytes; `process.exit()` right after a bare `write` can drop the unflushed tail on a pipe.
 */
export function writeShardLine(out: LineSink, msg: ShardMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(`${formatShardLine(msg)}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * How long after a child exits the parent still waits for its stdout to deliver the reports line.
 * The exit and the stdout pump race: a clean exit can resolve before the last pipe reads are parsed.
 */
export const SHARD_EXIT_DRAIN_MS = 10_000;

/**
 * The parent's view of one child: feeds it stdout lines and the exit, exposes `started` and
 * `reports`. An exit only fails the shard if no reports line arrived within `drainMs` after it.
 */
export class ShardLink {
  readonly started: Promise<number>;
  readonly reports: Promise<ViewerReport[]>;
  private resolveStarted: (n: number) => void = () => undefined;
  private rejectStarted: (e: Error) => void = () => undefined;
  private resolveReports: (r: ViewerReport[]) => void = () => undefined;
  private rejectReports: (e: Error) => void = () => undefined;
  private gotReports = false;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly index: number,
    private readonly drainMs = SHARD_EXIT_DRAIN_MS,
  ) {
    this.started = new Promise((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.reports = new Promise((resolve, reject) => {
      this.resolveReports = resolve;
      this.rejectReports = reject;
    });
    // Unhandled until awaited; never let an early failure crash the process.
    this.started.catch(() => undefined);
    this.reports.catch(() => undefined);
  }

  onLine(line: string): void {
    const msg = parseShardLine(line);
    if (!msg) return;
    if (msg.type === "started") this.resolveStarted(msg.viewers);
    else if (msg.type === "reports") {
      this.gotReports = true;
      clearTimeout(this.exitTimer);
      this.resolveReports(msg.reports);
    } else this.fail(new Error(`load shard ${this.index}: ${msg.error}`));
  }

  /** The child exited; `stderrTail` is read when the grace ends, for the error message. */
  onExit(code: number, stderrTail: () => string[]): void {
    if (this.gotReports) return;
    this.exitTimer = setTimeout(() => {
      if (this.gotReports) return;
      this.fail(new Error(`load shard ${this.index} exited (${code}): ${stderrTail().slice(-3).join(" | ")}`));
    }, this.drainMs);
  }

  private fail(e: Error): void {
    this.rejectStarted(e);
    this.rejectReports(e);
  }
}
