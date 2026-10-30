// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `chat-surge-guard` pass (ADR 0015 decision 6): for each channel with the surge guard
 * enabled, read the new-session counts and the override, decide (`hysteresis.ts`) and apply. Begin
 * and end write the outbox event and the audit row in one transaction, with the override write as
 * its last statement (compare-and-set: a moderator's override in between wins and rolls this back);
 * the `surge` frame is published after the commit.
 */
import { sql } from "drizzle-orm";
import { ChatControlMessage } from "@commonair/contracts/chat";
import { BUS } from "@commonair/contracts/events";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import type { Executor } from "@commonair/db";
import { GATE_ELIGIBLE } from "@commonair/integrity";
import type { WorkerContext } from "../context.ts";
import { audit, emit, safeErrorCode } from "../moderation/records.ts";
import { type ChatGateConfig, chatGateConfig } from "./config.ts";
import {
  type SurgeAction,
  type SurgeCounts,
  SURGE_JUDGE_AFTER_MS,
  SURGE_TRAILING_MS,
  SURGE_WINDOW_MS,
  decide,
  overrideTtlSeconds,
  surgeTrigger,
} from "./hysteresis.ts";
import { casOverride, readOverride, SURGE_OPEN_TTL_SECONDS, surgeOpenKey, type StoredOverride } from "./state.ts";

export interface SurgeGuardResult {
  channels: number;
  begun: number;
  ended: number;
}

type Row = Record<string, unknown>;
const tsz = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** The override changed under us (a moderator acted): roll back and leave it to the next run. */
class OverrideChanged extends Error {}

interface GuardedChannel {
  id: string;
  slug: string;
  liveBroadcastId: string | null;
  settings: ChannelChatSettings["surgeGuard"];
}

async function guardedChannels(ctx: Pick<WorkerContext, "db">): Promise<GuardedChannel[]> {
  const rows = (await ctx.db.execute(sql`
    select c.id, c.slug, c.live_broadcast_id, c.chat_settings from channels c
     where coalesce((c.chat_settings->'surgeGuard'->>'enabled')::boolean, false)`)) as unknown as Row[];
  return rows.map((r) => {
    const parsed = ChannelChatSettings.safeParse(r.chat_settings ?? {});
    return {
      id: String(r.id),
      slug: String(r.slug),
      liveBroadcastId: typeof r.live_broadcast_id === "string" ? r.live_broadcast_id : null,
      settings: (parsed.success ? parsed.data : ChannelChatSettings.parse({})).surgeGuard,
    };
  });
}

/** New sessions on the live broadcast (`playback_sessions_broadcast_idx`) and recent follow bursts. */
export async function surgeCounts(
  db: Executor,
  channelId: string,
  broadcastId: string,
  now: Date,
): Promise<SurgeCounts> {
  const window = new Date(now.getTime() - SURGE_WINDOW_MS);
  const trailing = new Date(window.getTime() - SURGE_TRAILING_MS);
  const judged = new Date(now.getTime() - SURGE_JUDGE_AFTER_MS);
  const [r] = (await db.execute(sql`
    select count(*) filter (where ps.started_at >= ${tsz(window)})::int as new_sessions,
           count(*) filter (where ps.started_at < ${tsz(window)})::int as trailing,
           count(*) filter (where ps.started_at >= ${tsz(window)} and ps.started_at <= ${tsz(judged)})::int as judged,
           count(*) filter (where ps.started_at >= ${tsz(window)} and ps.started_at <= ${tsz(judged)}
                              and not ${GATE_ELIGIBLE})::int as unverified,
           exists (select 1 from integrity_flags f
                    where f.channel_id = ${channelId}::uuid and f.signal = 'follow_burst'
                      and f.created_at >= ${tsz(window)}) as follow_burst
      from playback_sessions ps
     where ps.broadcast_id = ${broadcastId}::uuid and ps.channel_id = ${channelId}::uuid
       and ps.started_at >= ${tsz(trailing)} and ps.started_at <= ${tsz(now)}`)) as unknown as Row[];
  return {
    newSessions: Number(r?.new_sessions ?? 0),
    trailingSessions: Number(r?.trailing ?? 0),
    judged: Number(r?.judged ?? 0),
    unverified: Number(r?.unverified ?? 0),
    followBurst: r?.follow_burst === true,
  };
}

export async function runSurgeGuard(
  ctx: WorkerContext,
  cfg: ChatGateConfig = chatGateConfig(),
): Promise<SurgeGuardResult> {
  const result: SurgeGuardResult = { channels: 0, begun: 0, ended: 0 };
  if (!cfg.surgeGuard) return result;
  const now = ctx.now();
  for (const ch of await guardedChannels(ctx)) {
    result.channels++;
    try {
      const counts = ch.liveBroadcastId ? await surgeCounts(ctx.db, ch.id, ch.liveBroadcastId, now) : null;
      const trigger = counts ? surgeTrigger(counts, ch.settings.triggerUnverifiedRatio) : null;
      const stored = await readOverride(ctx.valkey, ch.id);
      const open = (await ctx.valkey.exists(surgeOpenKey(ch.id))) === 1;
      const actions = decide({
        now,
        current: stored.value,
        open,
        trigger,
        cooldownMinutes: ch.settings.cooldownMinutes,
      });
      let current = stored;
      for (const a of actions) {
        const applied = await apply(ctx, ch, a, current, now, counts);
        if (applied === null) break;
        current = applied;
        if (a.kind === "begin") result.begun++;
        if (a.kind === "end" || a.kind === "expired") result.ended++;
      }
    } catch (err) {
      // One channel's failure never stops the others; the next run (30 s) retries it.
      ctx.logger.warn("surge guard: channel pass failed", { channelId: ch.id, errorCode: safeErrorCode(err) });
    }
  }
  if (result.begun || result.ended) ctx.logger.info("surge guard", { ...result });
  return result;
}

/** Apply one action; returns the override as it now stands, or null when a moderator got there first. */
async function apply(
  ctx: WorkerContext,
  ch: GuardedChannel,
  a: SurgeAction,
  current: StoredOverride,
  now: Date,
  counts: SurgeCounts | null,
): Promise<StoredOverride | null> {
  const cas = async (next: Parameters<typeof casOverride>[3]) => {
    const ttl = next ? overrideTtlSeconds(next, now) : 1;
    if (!(await casOverride(ctx.valkey, ch.id, current.raw, next, ttl))) throw new OverrideChanged();
  };
  try {
    switch (a.kind) {
      case "expired":
        await ctx.db.transaction(async (tx) => {
          await emit(tx, "chat.surge.end", ch.id, { reason: "expired", by_user_id: null }, now);
          await audit(tx, surgeAudit(ch.id, "chat.surge.end", { reason: "expired" }), now);
        });
        await ctx.valkey.del(surgeOpenKey(ch.id));
        await publish(ctx, ch, { state: "off", until: null });
        return current;
      case "begin":
        await ctx.db.transaction(async (tx) => {
          await emit(tx, "chat.surge.begin", ch.id, { trigger: a.trigger, until: a.next.until, by_user_id: null }, now);
          await audit(
            tx,
            surgeAudit(ch.id, "chat.surge.begin", {
              trigger: a.trigger,
              cooldownMinutes: ch.settings.cooldownMinutes,
              newSessions: counts?.newSessions ?? 0,
              judged: counts?.judged ?? 0,
              unverified: counts?.unverified ?? 0,
            }),
            now,
          );
          await cas(a.next);
        });
        await ctx.valkey.set(surgeOpenKey(ch.id), "1", "EX", SURGE_OPEN_TTL_SECONDS);
        await publish(ctx, ch, { state: "on", until: a.next.until });
        return { raw: JSON.stringify(a.next), value: a.next };
      case "extend":
        await cas(a.next);
        await publish(ctx, ch, { state: "on", until: a.next.until });
        return { raw: JSON.stringify(a.next), value: a.next };
      case "end":
        await ctx.db.transaction(async (tx) => {
          await emit(tx, "chat.surge.end", ch.id, { reason: "cooldown", by_user_id: null }, now);
          await audit(tx, surgeAudit(ch.id, "chat.surge.end", { reason: "cooldown" }), now);
          await cas(null);
        });
        await ctx.valkey.del(surgeOpenKey(ch.id));
        await publish(ctx, ch, { state: "off", until: null });
        return { raw: null, value: null };
      case "clear":
        await cas(null);
        await publish(ctx, ch, { state: "off", until: null });
        return { raw: null, value: null };
    }
  } catch (err) {
    if (err instanceof OverrideChanged) return null;
    throw err;
  }
}

function surgeAudit(channelId: string, action: string, details: Record<string, string | number>) {
  return { action, subjectType: "channel", subjectId: channelId, channelId, details };
}

async function publish(
  ctx: WorkerContext,
  ch: GuardedChannel,
  s: { state: "off" | "on" | "suppressed"; until: string | null },
): Promise<void> {
  try {
    const frame = ChatControlMessage.parse({ op: "surge", channel: ch.slug, ...s });
    await ctx.valkey.publish(BUS.chatControl(ch.id), JSON.stringify(frame));
  } catch (err) {
    // Chat re-reads the override within seconds (its cache), so a lost frame only delays the banner.
    ctx.logger.warn("surge frame publish failed", { channelId: ch.id, errorCode: safeErrorCode(err) });
  }
}
