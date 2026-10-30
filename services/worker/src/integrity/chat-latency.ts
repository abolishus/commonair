// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel median viewer latency (`KEYS.chatLatency`, ADR 0012 amendment 1 decision 4), written
 * after each scoring pass. Chat places a live message without a `mediaTs` hint (IRC, bots, the
 * HTTP API) at receive time minus this value. Only verified, fetch-judged sessions count: each
 * sample carries the viewer's clock error and a bot can report anything, so the median of
 * gate-eligible sessions and the [0, 60] s cap bound both.
 */
import { KEYS } from "@commonair/contracts/internal";
import { GATE_ELIGIBLE } from "@commonair/integrity";
import { sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";

/** The key lives one minute; a pass runs every 15 s, so a channel that loses its quorum falls back to L = 0 soon. */
export const CHAT_LATENCY_TTL_SECONDS = 60;
/** Fewer reporting sessions than this write nothing (one or two viewers' clocks are not a median). */
export const CHAT_LATENCY_MIN_SESSIONS = 3;
/** The clamp window: a larger latency would only be clamped away. */
export const CHAT_LATENCY_MAX_MS = 60_000;

interface Row {
  channel_id: string;
  median_ms: number | string;
}

/** The median per live channel, capped, for channels with at least the quorum; milliseconds. */
export async function channelLatencies(ctx: Pick<WorkerContext, "db">): Promise<Map<string, number>> {
  // Bounded to channels with a live broadcast and that broadcast's open sessions
  // (`playback_sessions_active_idx` on channel_id where ended_at is null).
  const rows = (await ctx.db.execute(sql`
    select c.id as channel_id,
           percentile_cont(0.5) within group (order by ps.latency_ms) as median_ms
      from channels c
      join playback_sessions ps
        on ps.channel_id = c.id
       and ps.broadcast_id = c.live_broadcast_id
       and ps.ended_at is null
     where c.live_broadcast_id is not null
       and ps.latency_ms is not null
       and ${GATE_ELIGIBLE}
     group by c.id
    having count(*) >= ${CHAT_LATENCY_MIN_SESSIONS}`)) as unknown as Row[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const ms = Number(r.median_ms);
    if (!Number.isFinite(ms)) continue;
    out.set(r.channel_id, Math.min(CHAT_LATENCY_MAX_MS, Math.max(0, ms)));
  }
  return out;
}

/** Seconds as the key stores them: millisecond precision, no exponent. */
export const latencySecondsText = (ms: number): string => String(Math.round(ms) / 1000);

export async function writeChatLatency(ctx: WorkerContext): Promise<{ channels: number }> {
  const medians = await channelLatencies(ctx);
  if (medians.size === 0) return { channels: 0 };
  const pipeline = ctx.valkey.pipeline();
  for (const [channelId, ms] of medians)
    pipeline.set(KEYS.chatLatency(channelId), latencySecondsText(ms), "EX", CHAT_LATENCY_TTL_SECONDS);
  const results = await pipeline.exec();
  const failed = results?.find(([err]) => err !== null)?.[0];
  if (failed) throw failed;
  return { channels: medians.size };
}
