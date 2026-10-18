// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Segment stream consumer: a consumer group on STREAMS.segments. Entries are
 * read in batches, folded per minute, written in one transaction and only then
 * acknowledged; entries left pending by a crashed consumer are reclaimed after
 * a minute. Processing is at-least-once: a crash between commit and XACK counts
 * that batch twice, which the per-minute granularity keeps negligible.
 */
import type { ValkeyClient } from "@commonair/service";
import { hostname } from "node:os";
import type { WorkerContext } from "../context.ts";
import { metrics } from "../metrics.ts";
import { startLoop, type LoopHandle } from "../runtime/loop.ts";
import { aggregate, parseEntry, type Aggregate } from "./aggregate.ts";

export const SEGMENT_GROUP = "worker";
type Entry = [id: string, fields: string[]];

export interface SegmentConsumerOptions {
  consumer?: string;
  batchSize?: number;
  blockMs?: number;
  /** Pending entries idle this long are reclaimed from dead consumers. */
  claimIdleMs?: number;
  /** Entries older than this are trimmed from the stream. */
  retentionMs?: number;
  maintenanceEveryMs?: number;
}

/** Bounded session → broadcast cache (sessions never change broadcast). */
export class BroadcastCache {
  private readonly map = new Map<string, string | null>();
  constructor(private readonly max = 50_000) {}
  get(sid: string) {
    return this.map.get(sid);
  }
  has(sid: string) {
    return this.map.has(sid);
  }
  set(sid: string, bid: string | null) {
    if (this.map.size >= this.max) {
      // Map iteration order is insertion order: drop the oldest entry.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(sid, bid);
  }
}

export async function ensureGroup(client: ValkeyClient, stream: string): Promise<void> {
  try {
    await client.xgroup("CREATE", stream, SEGMENT_GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
  }
}

async function resolveBroadcasts(ctx: WorkerContext, cache: BroadcastCache, sids: string[]) {
  const missing = [...new Set(sids)].filter((s) => !cache.has(s));
  if (missing.length === 0) return;
  const rows = await ctx.sql<{ id: string; broadcast_id: string | null }[]>`
    select id, broadcast_id from playback_sessions where id = any(${missing}::uuid[])`;
  const found = new Map(rows.map((r) => [r.id, r.broadcast_id]));
  // Unknown sessions are cached as null too; a forged sid must not cost a query per fetch.
  for (const sid of missing) cache.set(sid, found.get(sid) ?? null);
}

export async function writeAggregate(ctx: WorkerContext, agg: Aggregate): Promise<void> {
  if (agg.egress.length === 0 && agg.sessions.length === 0) return;
  await ctx.sql.begin(async (tx) => {
    if (agg.egress.length > 0) {
      const rows = agg.egress.map((r) => [r.broadcastId, r.bucketStart.toISOString(), r.source, r.bytes, r.requests]);
      await tx`
        insert into egress_samples (broadcast_id, bucket_start, source, bytes, requests)
        select v.b::uuid, v.t::timestamptz, v.s::delivery_source, v.n::bigint, v.r::int
        from (values ${tx(rows)}) as v(b, t, s, n, r)
        on conflict (broadcast_id, bucket_start, source) do update
          set bytes = egress_samples.bytes + excluded.bytes,
              requests = egress_samples.requests + excluded.requests`;
    }
    if (agg.sessions.length > 0) {
      const rows = agg.sessions.map((s) => [s.sessionId, s.segments, s.bytesHttp]);
      await tx`
        update playback_sessions p
           set segments_fetched = p.segments_fetched + v.segs::int,
               bytes_http = p.bytes_http + v.bytes::bigint
          from (values ${tx(rows)}) as v(id, segs, bytes)
         where p.id = v.id::uuid`;
    }
  });
}

/** Process one batch of entries end to end; returns how many entries were acknowledged. */
export async function processEntries(
  ctx: WorkerContext,
  client: ValkeyClient,
  cache: BroadcastCache,
  entries: readonly Entry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const fetches = [];
  let malformed = 0;
  for (const [, fields] of entries) {
    const f = parseEntry(fields);
    if (f) fetches.push(f);
    else malformed++;
  }
  if (malformed > 0) ctx.logger.warn("dropping malformed segment entries", { count: malformed });
  await resolveBroadcasts(
    ctx,
    cache,
    fetches.map((f) => f.sid),
  );
  await writeAggregate(
    ctx,
    aggregate(fetches, (sid) => cache.get(sid)),
  );
  await client.xack(ctx.segmentStream, SEGMENT_GROUP, ...entries.map(([id]) => id));
  metrics.segmentEntries.add(entries.length);
  return entries.length;
}

type ReadReply = [stream: string, entries: Entry[]][] | null;

export function startSegmentConsumer(ctx: WorkerContext, opts: SegmentConsumerOptions = {}): LoopHandle {
  const consumer = opts.consumer ?? `${hostname()}-${process.pid}`;
  const batchSize = opts.batchSize ?? 2000;
  const blockMs = opts.blockMs ?? 1000;
  const claimIdleMs = opts.claimIdleMs ?? 60_000;
  const retentionMs = opts.retentionMs ?? 3_600_000;
  const maintenanceEveryMs = opts.maintenanceEveryMs ?? 30_000;
  // XREADGROUP BLOCK holds its connection, so the consumer gets a dedicated one. It is
  // never key-prefixed: iovalkey does not prefix every stream command (XGROUP, XAUTOCLAIM)
  // consistently, so the stream name is always used verbatim (tests pass a unique one).
  const client = ctx.valkey.duplicate({ keyPrefix: "" });
  const cache = new BroadcastCache();
  let groupReady = false;
  let lastMaintenance = 0;

  const maintenance = async () => {
    const reply = (await client.xautoclaim(
      ctx.segmentStream,
      SEGMENT_GROUP,
      consumer,
      claimIdleMs,
      "0",
      "COUNT",
      batchSize,
    )) as [string, Entry[]];
    const claimed = (reply[1] ?? []).filter((e): e is Entry => Array.isArray(e) && Array.isArray(e[1]));
    if (claimed.length > 0) {
      ctx.logger.info("reclaimed stale segment entries", { count: claimed.length });
      await processEntries(ctx, client, cache, claimed);
    }
    const minId = `${ctx.now().getTime() - retentionMs}-0`;
    await client.xtrim(ctx.segmentStream, "MINID", "~", minId);
  };

  const loop = startLoop("segment consumer", ctx.logger, async () => {
    if (!groupReady) {
      await ensureGroup(client, ctx.segmentStream);
      groupReady = true;
    }
    if (Date.now() - lastMaintenance >= maintenanceEveryMs) {
      lastMaintenance = Date.now();
      await maintenance();
    }
    let reply: ReadReply;
    try {
      reply = (await client.xreadgroup(
        "GROUP",
        SEGMENT_GROUP,
        consumer,
        "COUNT",
        batchSize,
        "BLOCK",
        blockMs,
        "STREAMS",
        ctx.segmentStream,
        ">",
      )) as ReadReply;
    } catch (err) {
      // The stream (and its group) can disappear, e.g. after a Valkey restart: recreate next pass.
      if (err instanceof Error && err.message.includes("NOGROUP")) groupReady = false;
      throw err;
    }
    const entries = reply?.[0]?.[1] ?? [];
    await processEntries(ctx, client, cache, entries);
    return 0;
  });

  return {
    async stop() {
      // Unblock a pending XREADGROUP quickly by disconnecting after the loop notices.
      const stopped = loop.stop();
      await Promise.race([stopped, new Promise((r) => setTimeout(r, blockMs + 500))]);
      client.disconnect();
      await stopped.catch(() => {});
    },
  };
}
