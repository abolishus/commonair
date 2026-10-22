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
