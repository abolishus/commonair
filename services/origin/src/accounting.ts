// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Accounting off the request path. Nothing here is awaited by a response:
 *
 * - SegmentLog buffers one SegmentFetch per playlist/segment/part served to a viewer
 *   and XADDs them to STREAMS.segments in pipelined batches (the worker aggregates).
 * - EgressAccumulator sums bytes per broadcast × minute × delivery source in process
 *   and upserts (adding) into `egress_samples` once a minute.
 * - ProductionTracker records what MediaMTX produced per channel per minute (new
 *   segments listed in media playlists, bytes of media objects pulled), the input to
 *   relay issuance (see issuance.ts).
 *
 * All three are bounded: under sustained backpressure they drop records and count
 * the drops in metrics rather than grow without limit.
 */
import { sql } from "drizzle-orm";
import type { SegmentFetch } from "@commonair/contracts/internal";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";
import type { MediaKind } from "./paths.ts";

export const MINUTE_MS = 60_000;
export const minuteOf = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** Periodic async task that never overlaps itself and runs a final time on stop. */
class Ticker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(
    private readonly everyMs: number,
    private readonly task: () => Promise<void>,
  ) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref?.();
  }
  tick(): Promise<void> {
    this.running ??= this.task().finally(() => (this.running = undefined));
    return this.running;
  }
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
    await this.tick();
  }
}

// ---------------------------------------------------------------------------------------

export interface SegmentLogOptions {
  valkey: Pick<ValkeyClient, "pipeline">;
  stream: string;
  /** Approximate MAXLEN so an absent consumer cannot exhaust Valkey memory. */
  maxLen?: number;
  flushMs?: number;
  batchSize?: number;
  /** Max buffered entries while Valkey is unreachable. */
  maxBuffer?: number;
  logger?: Logger;
  metrics?: OriginMetrics;
}

export class SegmentLog {
  private buffer: SegmentFetch[] = [];
  private readonly ticker: Ticker;
  private readonly batchSize: number;
  private readonly maxBuffer: number;
  private readonly metrics: OriginMetrics;
  /** Entries acknowledged by Valkey (tests, diagnostics). */
  written = 0;

  constructor(private readonly opts: SegmentLogOptions) {
    this.batchSize = opts.batchSize ?? 500;
    this.maxBuffer = opts.maxBuffer ?? 100_000;
    this.metrics = opts.metrics ?? noopMetrics;
    this.ticker = new Ticker(opts.flushMs ?? 250, () => this.flushNow());
  }

  start(): void {
    this.ticker.start();
  }
  stop(): Promise<void> {
    return this.ticker.stop();
  }
  get buffered(): number {
    return this.buffer.length;
  }

  record(entry: SegmentFetch): void {
    if (this.buffer.length >= this.maxBuffer) {
      this.metrics.accountingDropped("segment_fetch", 1);
      return;
    }
    this.buffer.push(entry);
    if (this.buffer.length >= this.batchSize) void this.ticker.tick();
  }

  flush(): Promise<void> {
    return this.ticker.tick();
  }

  private async flushNow(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      const p = this.opts.valkey.pipeline();
      for (const e of batch) p.xadd(this.opts.stream, "MAXLEN", "~", this.opts.maxLen ?? 1_000_000, "*", ...fields(e));
      try {
        const results = (await p.exec()) ?? [];
        const failed = results.filter(([err]) => err).length;
        this.written += batch.length - failed;
        if (failed > 0) this.opts.logger?.warn("segment log: some XADDs failed", { failed });
      } catch (err) {
        // Put the batch back (bounded) and retry on the next tick.
        const room = Math.max(0, this.maxBuffer - this.buffer.length);
        this.buffer.unshift(...batch.slice(0, room));
        if (batch.length > room) this.metrics.accountingDropped("segment_fetch", batch.length - room);
        this.opts.logger?.warn("segment log: valkey unavailable", { err, buffered: this.buffer.length });
        return;
      }
    }
  }
}

function fields(e: SegmentFetch): string[] {
  const f = ["sid", e.sid, "cid", e.cid, "src", e.src];
  if (e.rid) f.push("rid", e.rid);
  f.push("kind", e.kind, "bytes", String(e.bytes), "at", String(e.at));
  return f;
}

// ---------------------------------------------------------------------------------------

export type EgressSource = (typeof schema.egressSamples.$inferInsert)["source"];

interface EgressCell {
  broadcastId: string;
  bucketStart: number;
  source: EgressSource;
  bytes: number;
  requests: number;
}

export interface EgressOptions {
  db: Executor;
  flushMs?: number;
  maxCells?: number;
  logger?: Logger;
  metrics?: OriginMetrics;
}

export class EgressAccumulator {
  private cells = new Map<string, EgressCell>();
  private readonly ticker: Ticker;
  private readonly metrics: OriginMetrics;

  constructor(private readonly opts: EgressOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
    this.ticker = new Ticker(opts.flushMs ?? MINUTE_MS, () => this.flushNow());
  }

  start(): void {
    this.ticker.start();
  }
  stop(): Promise<void> {
    return this.ticker.stop();
  }
  flush(): Promise<void> {
    return this.ticker.tick();
  }
  /** Snapshot of unflushed totals (tests, diagnostics). */
  pending(): EgressCell[] {
    return [...this.cells.values()].map((c) => ({ ...c }));
  }

  add(broadcastId: string, source: EgressSource, bytes: number, at: number): void {
    this.merge({ broadcastId, source, bytes, requests: 1, bucketStart: minuteOf(at) });
  }

  private merge(c: EgressCell): void {
    const key = `${c.broadcastId}|${c.bucketStart}|${c.source}`;
    const cur = this.cells.get(key);
    if (cur) {
      cur.bytes += c.bytes;
      cur.requests += c.requests;
    } else if (this.cells.size >= (this.opts.maxCells ?? 200_000)) {
      this.metrics.accountingDropped("egress", 1);
    } else this.cells.set(key, { ...c });
  }

  private async flushNow(): Promise<void> {
    if (this.cells.size === 0) return;
    const batch = [...this.cells.values()];
    this.cells = new Map();
    const t = schema.egressSamples;
    let i = 0;
    try {
      for (; i < batch.length; i += 1000) {
        await this.opts.db
          .insert(t)
          .values(
            batch.slice(i, i + 1000).map((c) => ({
              broadcastId: c.broadcastId,
              bucketStart: new Date(c.bucketStart),
              source: c.source,
              bytes: c.bytes,
              requests: c.requests,
            })),
          )
          .onConflictDoUpdate({
            target: [t.broadcastId, t.bucketStart, t.source],
            set: { bytes: sql`${t.bytes} + excluded.bytes`, requests: sql`${t.requests} + excluded.requests` },
          });
      }
    } catch (err) {
      // Each chunk is its own statement: chunks before `i` are committed, so only the failed chunk
      // and those after it go back into the accumulator (re-merging all would double count).
      this.opts.logger?.warn("egress flush failed", { err, cells: batch.length - i });
      for (const c of batch.slice(i)) this.merge(c);
    }
  }
}

// ---------------------------------------------------------------------------------------

/** What MediaMTX produced in one directory (source or a rendition) of a channel in one minute. */
export interface DirProduction {
  /** Distinct full media segments first listed in a media playlist during the minute. */
  segments: number;
  /** Bytes of full segments (and init sections) first pulled from MediaMTX during the minute. */
  segmentBytes: number;
  /** Bytes of LL-HLS parts first pulled during the minute. */
  partBytes: number;
}

export type ChannelMinute = Map<string, DirProduction>;

export class ProductionTracker {
  /** channel path → minute → dir → production */
  private readonly minutes = new Map<string, Map<number, ChannelMinute>>();
  /** dir → segment name → first-seen ms; a segment counts once, in the minute it first appears. */
  private readonly seen = new Map<string, Map<string, number>>();

  constructor(private readonly retainMs = 10 * MINUTE_MS) {}

  notePlaylist(channelPath: string, dir: string, segmentNames: string[], at: number): void {
    let seen = this.seen.get(dir);
    if (!seen) this.seen.set(dir, (seen = new Map()));
    let fresh = 0;
    for (const name of segmentNames) {
      if (seen.has(name)) continue;
      seen.set(name, at);
      fresh++;
    }
    if (fresh > 0) this.cell(channelPath, dir, at).segments += fresh;
  }

  noteObject(channelPath: string, dir: string, kind: Exclude<MediaKind, "playlist">, bytes: number, at: number): void {
    const c = this.cell(channelPath, dir, at);
    if (kind === "part") c.partBytes += bytes;
    else c.segmentBytes += bytes;
  }

  get(channelPath: string, bucketStart: number): ChannelMinute | undefined {
    return this.minutes.get(channelPath)?.get(bucketStart);
  }

  prune(now: number): void {
    const cutoff = now - this.retainMs;
    for (const [path, byMinute] of this.minutes) {
      for (const m of byMinute.keys()) if (m < cutoff) byMinute.delete(m);
      if (byMinute.size === 0) this.minutes.delete(path);
    }
    for (const [dir, names] of this.seen) {
      for (const [n, at] of names) if (at < cutoff) names.delete(n);
      if (names.size === 0) this.seen.delete(dir);
    }
  }

  private cell(channelPath: string, dir: string, at: number): DirProduction {
    const m = minuteOf(at);
    let byMinute = this.minutes.get(channelPath);
    if (!byMinute) this.minutes.set(channelPath, (byMinute = new Map()));
    let minute = byMinute.get(m);
    if (!minute) byMinute.set(m, (minute = new Map()));
    let c = minute.get(dir);
    if (!c) minute.set(dir, (c = { segments: 0, segmentBytes: 0, partBytes: 0 }));
    return c;
  }
}
