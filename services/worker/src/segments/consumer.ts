// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Segment stream consumer: a consumer group on STREAMS.segments. Entries are
 * read in batches, folded per minute, written in one transaction and only then
 * acknowledged; entries left pending by a crashed consumer are reclaimed after
 * a minute. Processing is at-least-once: a crash between commit and XACK counts
 * that batch twice, which the per-minute granularity keeps negligible.
 */
import { recordFetches } from "@commonair/integrity";
import type { ValkeyClient } from "@commonair/service";
import { hostname } from "node:os";
import type { WorkerContext } from "../context.ts";
import { fetchEvidence } from "../integrity/fetches.ts";
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

/**
 * Bounded session → broadcast cache. A known broadcast never changes, so it is kept
 * until evicted; "no broadcast yet" (unknown session, or a session whose broadcast is
 * attached later) expires after `nullTtlMs` so it is looked up again.
 */
export class BroadcastCache {
  private readonly map = new Map<string, { bid: string | null; until: number }>();
  constructor(
    private readonly max = 50_000,
    private readonly nullTtlMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}
  private live(sid: string) {
    const e = this.map.get(sid);
    if (e && e.until <= this.clock()) {
      this.map.delete(sid);
      return undefined;
    }
    return e;
  }
  get(sid: string) {
    return this.live(sid)?.bid;
  }
  has(sid: string) {
    return this.live(sid) !== undefined;
  }
  set(sid: string, bid: string | null) {
    this.map.delete(sid);
    if (this.map.size >= this.max) {
      // Map iteration order is insertion order: drop the oldest entry.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(sid, { bid, until: bid === null ? this.clock() + this.nullTtlMs : Number.POSITIVE_INFINITY });
  }
}

/** Entries delivered this many times without being acknowledged are dropped (and logged). */
export const MAX_DELIVERIES = 5;

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

/**
 * Integrity fetch counters for the batch (origin and p2p entries). Written through the
 * application connection, where the scorer reads them (the consumer's own connection is
 * unprefixed and reserved for the stream). A failure here is logged, not thrown: the batch
 * is already committed, and retrying it would count its egress twice to save a few
 * counter increments.
 */
async function recordEvidence(ctx: WorkerContext, fetches: Parameters<typeof fetchEvidence>[0]): Promise<void> {
  const evidence = fetchEvidence(fetches);
  if (evidence.length === 0) return;
  try {
    await recordFetches(ctx.valkey, evidence);
    metrics.fetchEvidence.add(evidence.length, { outcome: "recorded" });
  } catch (err) {
    metrics.fetchEvidence.add(evidence.length, { outcome: "failed" });
    ctx.logger.warn("recording integrity fetch evidence failed", { count: evidence.length, err });
  }
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
  const nowMs = ctx.now().getTime();
  for (const [, fields] of entries) {
    const f = parseEntry(fields, nowMs);
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
  await recordEvidence(ctx, fetches);
  await client.xack(ctx.segmentStream, SEGMENT_GROUP, ...entries.map(([id]) => id));
  metrics.segmentEntries.add(entries.length);
  return entries.length;
}

/**
 * Process a batch; if the batch as a whole fails, retry entry by entry so one bad
 * entry cannot hold back the rest. Entries that still fail stay pending and are
 * reclaimed later (and dropped after MAX_DELIVERIES).
 */
export async function processResilient(
  ctx: WorkerContext,
  client: ValkeyClient,
  cache: BroadcastCache,
  entries: readonly Entry[],
): Promise<number> {
  try {
    return await processEntries(ctx, client, cache, entries);
  } catch (err) {
    if (entries.length <= 1) throw err;
    ctx.logger.warn("segment batch failed; retrying entries one by one", { count: entries.length, err });
    let done = 0;
    for (const entry of entries) {
      try {
        done += await processEntries(ctx, client, cache, [entry]);
      } catch (entryErr) {
        ctx.logger.warn("segment entry failed; left pending", { id: entry[0], err: entryErr });
      }
    }
    return done;
  }
}

type PendingDetail = [id: string, consumer: string, idleMs: number, deliveries: number];

/** Acknowledge (drop) claimed entries that have been delivered MAX_DELIVERIES times or more. */
export async function dropPoison(
  ctx: WorkerContext,
  client: ValkeyClient,
  claimed: readonly Entry[],
): Promise<Entry[]> {
  if (claimed.length === 0) return [];
  const first = claimed[0]?.[0] ?? "-";
  const last = claimed.at(-1)?.[0] ?? "+";
  const pending = (await client.xpending(
    ctx.segmentStream,
    SEGMENT_GROUP,
    first,
    last,
    claimed.length * 2 + 10,
  )) as PendingDetail[];
  const deliveries = new Map(pending.map(([id, , , n]) => [id, Number(n)]));
  const poison = claimed.filter(([id]) => (deliveries.get(id) ?? 0) >= MAX_DELIVERIES);
  if (poison.length === 0) return [...claimed];
  await client.xack(ctx.segmentStream, SEGMENT_GROUP, ...poison.map(([id]) => id));
  ctx.logger.error("dropping segment entries that failed repeatedly", {
    count: poison.length,
    ids: poison.slice(0, 10).map(([id]) => id),
  });
  const dropped = new Set(poison.map(([id]) => id));
  return claimed.filter(([id]) => !dropped.has(id));
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
    // Trim first and independently: a failing claim/process step must never stop trimming.
    try {
      const minId = `${ctx.now().getTime() - retentionMs}-0`;
      await client.xtrim(ctx.segmentStream, "MINID", "~", minId);
    } catch (err) {
      ctx.logger.error("segment stream trim failed", { err });
    }
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
      await processResilient(ctx, client, cache, await dropPoison(ctx, client, claimed));
    }
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
    await processResilient(ctx, client, cache, entries);
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
