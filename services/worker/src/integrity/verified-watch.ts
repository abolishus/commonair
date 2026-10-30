// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Verified-watch keys (`KEYS.verifiedWatch`, ADR 0015 decision 1), written after each scoring pass
 * for live channels with the gate on (only while `CHAT_WATCH_GATE` is on) or the surge guard
 * enabled (only while `CHAT_SURGE_GUARD` is on), so keys exist before a surge starts. Sources:
 * signed-in `GATE_ELIGIBLE` sessions on the live broadcast; the broadcaster, moderators, VIPs and
 * verified bots are exempt in chat and get no key. One pipelined `SET … EX 600` per user.
 */
import { sql } from "drizzle-orm";
import { KEYS, VERIFIED_WATCH_TTL_SECONDS } from "@commonair/contracts/internal";
import { GATE_ELIGIBLE, loadThresholds } from "@commonair/integrity";
import { type ChatGateConfig, chatGateConfig } from "../chat-gate/config.ts";
import { PRIVACY_RELAY_PREFIX, unlocks, type WatchRow } from "../chat-gate/unlocks.ts";
import type { WorkerContext } from "../context.ts";

type Row = Record<string, unknown>;

/** Live channels the writer covers under the instance flags; ids only. */
export async function gatedChannels(ctx: Pick<WorkerContext, "db">, cfg: ChatGateConfig): Promise<string[]> {
  if (!cfg.watchGate && !cfg.surgeGuard) return [];
  const gate = cfg.watchGate ? sql`coalesce((c.chat_settings->>'minVerifiedWatchSeconds')::int, 0) > 0` : sql`false`;
  const guard = cfg.surgeGuard
    ? sql`coalesce((c.chat_settings->'surgeGuard'->>'enabled')::boolean, false)`
    : sql`false`;
  const rows = (await ctx.db.execute(sql`
    select c.id from channels c
     where c.live_broadcast_id is not null and (${gate} or ${guard})`)) as unknown as Row[];
  return rows.map((r) => String(r.id));
}

export async function writeVerifiedWatch(
  ctx: WorkerContext,
  cfg: ChatGateConfig = chatGateConfig(),
): Promise<{ channels: number; keys: number }> {
  const channels = await gatedChannels(ctx, cfg);
  if (channels.length === 0) return { channels: 0, keys: 0 };
  const thresholds = await loadThresholds(ctx.db);
  const rows = (await ctx.db.execute(sql`
    select ps.channel_id, ps.broadcast_id, ps.user_id, ps.ip_hash,
           coalesce(ps.datacenter like ${`${PRIVACY_RELAY_PREFIX}%`}, false) as relay,
           sum(ps.watch_seconds)::int as seconds, min(ps.started_at) as first_at
      from channels c
      join playback_sessions ps on ps.channel_id = c.id and ps.broadcast_id = c.live_broadcast_id
      join users u on u.id = ps.user_id
     where c.id = any(${`{${channels.join(",")}}`}::uuid[])
       and ${GATE_ELIGIBLE}
       and ps.user_id <> c.owner_id
       and not (u.account_type = 'bot' and u.bot_verified)
       and not exists (select 1 from channel_roles r
                        where r.channel_id = c.id and r.user_id = ps.user_id and r.role in ('moderator', 'vip'))
     group by ps.channel_id, ps.broadcast_id, ps.user_id, ps.ip_hash, relay`)) as unknown as Row[];
  const facts: WatchRow[] = rows.map((r) => ({
    channelId: String(r.channel_id),
    broadcastId: String(r.broadcast_id),
    userId: String(r.user_id),
    ipHash: String(r.ip_hash),
    privacyRelay: r.relay === true,
    seconds: Number(r.seconds ?? 0),
    firstAt: r.first_at instanceof Date ? r.first_at : new Date(String(r.first_at)),
  }));
  const keys = unlocks(facts, thresholds.gateUnlocksPerAddress, cfg.secret);
  if (keys.length > 0) {
    const pipe = ctx.valkey.pipeline();
    for (const k of keys)
      pipe.set(KEYS.verifiedWatch(k.channelId, k.userId), JSON.stringify(k.value), "EX", VERIFIED_WATCH_TTL_SECONDS);
    const results = await pipe.exec();
    const failed = (results ?? []).find(([err]) => err);
    if (failed?.[0]) throw failed[0];
  }
  return { channels: channels.length, keys: keys.length };
}
