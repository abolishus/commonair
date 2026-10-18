// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live counters (every 10 s): verified viewers per live channel from the
 * heartbeat ZSETs and the integrity verdicts, published to KEYS.viewerCount,
 * folded into the broadcast's peak and viewer-seconds totals.
 */
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { isNull } from "drizzle-orm";
import type { WorkerContext } from "./context.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CounterOptions {
  /** Heartbeat age after which a ZSET member is stale (contract: 30 s). */
  staleMs?: number;
  /** Nominal tick, used for the first tick of a broadcast. */
  tickSeconds?: number;
  /** Cap on the seconds credited for one tick, so a stalled scheduler never credits a long gap. */
  maxElapsedSeconds?: number;
  countTtlSeconds?: number;
}

export interface ChannelCount {
  broadcastId: string;
  channelId: string;
  verified: number;
  excluded: number;
  pending: number;
  elapsedSeconds: number;
}

/** Internal bookkeeping key (not shared with other services). */
const lastTickKey = (broadcastId: string) => `worker:counters:last:${broadcastId}`;

/** Seconds to credit for this tick given the previous tick time (ms) and the broadcast start. */
export function creditSeconds(
  nowMs: number,
  lastMs: number | null,
  startedAtMs: number,
  tickSeconds: number,
  maxElapsedSeconds: number,
): number {
  const since = lastMs === null ? Math.min(tickSeconds, (nowMs - startedAtMs) / 1000) : (nowMs - lastMs) / 1000;
  return Math.max(0, Math.min(maxElapsedSeconds, since));
}

export async function updateLiveCounters(ctx: WorkerContext, opts: CounterOptions = {}): Promise<ChannelCount[]> {
  const staleMs = opts.staleMs ?? 30_000;
  const tickSeconds = opts.tickSeconds ?? 10;
  const maxElapsedSeconds = opts.maxElapsedSeconds ?? 30;
  const ttl = opts.countTtlSeconds ?? 30;
  const nowMs = ctx.now().getTime();
  const b = schema.broadcasts;
  const live = await ctx.db
    .select({ id: b.id, channelId: b.channelId, startedAt: b.startedAt })
    .from(b)
    .where(isNull(b.endedAt));

  const out: ChannelCount[] = [];
  for (const bc of live) {
    const key = KEYS.viewers(bc.channelId);
    await ctx.valkey.zremrangebyscore(key, "-inf", nowMs - staleMs);
    const members = (await ctx.valkey.zrange(key, 0, -1)).filter((m) => UUID.test(m));
    const counts = { verified: 0, excluded: 0, pending: 0 };
    if (members.length > 0) {
      const rows = await ctx.sql<{ verdict: keyof typeof counts; n: number }[]>`
        select verdict, count(*)::int as n from playback_sessions
         where id = any(${members}::uuid[]) and channel_id = ${bc.channelId} and ended_at is null
         group by verdict`;
      for (const r of rows) counts[r.verdict] = r.n;
    }
    await ctx.valkey.set(KEYS.viewerCount(bc.channelId), String(counts.verified), "EX", ttl);

    const prev = await ctx.valkey.set(lastTickKey(bc.id), String(nowMs), "EX", 3600, "GET");
    const lastMs = prev === null ? null : Number(prev);
    const elapsed = creditSeconds(
      nowMs,
      Number.isFinite(lastMs) ? lastMs : null,
      bc.startedAt.getTime(),
      tickSeconds,
      maxElapsedSeconds,
    );
    await ctx.sql`
      update broadcasts
         set peak_verified_viewers = greatest(peak_verified_viewers, ${counts.verified}),
             verified_viewer_seconds = verified_viewer_seconds + ${Math.round(counts.verified * elapsed)},
             excluded_viewer_seconds = excluded_viewer_seconds + ${Math.round(counts.excluded * elapsed)}
       where id = ${bc.id} and ended_at is null`;
    out.push({ broadcastId: bc.id, channelId: bc.channelId, ...counts, elapsedSeconds: elapsed });
  }
  return out;
}
