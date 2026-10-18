// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Housekeeping: expiry, pruning, stale-session closing, relay liveness, VOD retention. */
import { KEYS } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { and, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { WorkerContext } from "./context.ts";

const DAY = 86_400_000;
const ago = (ctx: WorkerContext, ms: number) => new Date(ctx.now().getTime() - ms);

/** Expired verification tokens and auth sessions. */
export async function expireAuthRows(ctx: WorkerContext) {
  const now = ctx.now();
  const v = await ctx.db
    .delete(schema.verifications)
    .where(lt(schema.verifications.expiresAt, now))
    .returning({ id: schema.verifications.id });
  const s = await ctx.db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, now))
    .returning({ id: schema.sessions.id });
  return { verifications: v.length, sessions: s.length };
}

export async function pruneWebhookDeliveries(ctx: WorkerContext, retentionDays = 30) {
  const rows = await ctx.db
    .delete(schema.webhookDeliveries)
    .where(lt(schema.webhookDeliveries.createdAt, ago(ctx, retentionDays * DAY)))
    .returning({ id: schema.webhookDeliveries.id });
  return { deleted: rows.length };
}

/**
 * Sessions with no heartbeat (or, never heartbeating, no start) within `idleMs`
 * are closed at their last sign of life, not at "now", so watch time is not inflated.
 */
export async function closeStalePlaybackSessions(ctx: WorkerContext, idleMs = 120_000) {
  const cutoff = ago(ctx, idleMs);
  const rows = await ctx.sql<{ id: string; channel_id: string }[]>`
    update playback_sessions
       set ended_at = coalesce(last_heartbeat_at, started_at)
     where ended_at is null and coalesce(last_heartbeat_at, started_at) < ${cutoff.toISOString()}::timestamptz
     returning id, channel_id`;
  // Drop them from the live heartbeat sets right away rather than waiting for the 30 s prune.
  const byChannel = new Map<string, string[]>();
  for (const r of rows) byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), r.id]);
  for (const [channelId, ids] of byChannel) await ctx.valkey.zrem(KEYS.viewers(channelId), ...ids);
  return { closed: rows.length };
}

/** Active/degraded relays whose last health check is older than `missedMs` go offline, with an audit row. */
export async function markRelaysOffline(ctx: WorkerContext, missedMs = 180_000) {
  const r = schema.relayNodes;
  const cutoff = ago(ctx, missedMs);
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(r)
      .set({ status: "offline" })
      .where(
        and(
          inArray(r.status, ["active", "degraded"]),
          sql`coalesce(${r.lastHealthAt}, ${r.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .returning({ id: r.id, lastHealthAt: r.lastHealthAt });
    if (rows.length > 0) {
      await tx.insert(schema.auditLog).values(
        rows.map((row) => ({
          id: uuidv7(),
          actorType: "system" as const,
          action: "relay.offline",
          subjectType: "relay_node",
          subjectId: row.id,
          reason: "missed heartbeats",
          details: { lastHealthAt: row.lastHealthAt?.toISOString() ?? null, thresholdMs: missedMs },
        })),
      );
      // Stop assigning viewers to it immediately.
      await ctx.valkey.hdel(KEYS.relays, ...rows.map((row) => row.id));
    }
    return { offline: rows.length };
  });
}

/** The only object prefix a VOD may own (trailing slash: "vods/a" must never match "vods/ab…"). */
export const vodPrefix = (vodId: string) => `vods/${vodId}/`;

/**
 * Expired VODs: delete their objects, then mark them deleted. A VOD whose
 * objects could not be deleted keeps its status and is retried next run.
 */
export async function enforceVodRetention(ctx: WorkerContext, batch = 50) {
  const v = schema.vods;
  if (!ctx.storage) {
    ctx.logger.warn("VOD retention skipped: object storage is not configured");
    return { deleted: 0, failed: 0, objects: 0 };
  }
  const due = and(isNotNull(v.expiresAt), lt(v.expiresAt, ctx.now()), ne(v.status, "deleted"));
  // The media unit writes VODs under exactly `vods/<vod id>/`. Anything else is refused: a
  // tampered or legacy prefix could otherwise delete another VOD's objects or the whole bucket.
  const ownPrefix = sql`${v.storagePrefix} = 'vods/' || ${v.id}::text || '/'`;
  const refused = await ctx.db
    .select({ id: v.id })
    .from(v)
    .where(and(due, sql`not (${ownPrefix})`))
    .limit(batch);
  for (const r of refused) ctx.logger.error("VOD retention: refusing unexpected storage prefix", { vodId: r.id });
  // Refused rows are excluded here so they can never starve valid ones out of the batch.
  const expired = await ctx.db
    .select({ id: v.id })
    .from(v)
    .where(and(due, ownPrefix))
    .orderBy(v.expiresAt)
    .limit(batch);
  let deleted = 0;
  let failed = refused.length;
  let objects = 0;
  for (const vod of expired) {
    try {
      objects += await ctx.storage.deletePrefix(ctx.mediaBucket, vodPrefix(vod.id));
      await ctx.db.update(v).set({ status: "deleted", removedReason: "retention" }).where(eq(v.id, vod.id));
      deleted++;
    } catch (err) {
      failed++;
      ctx.logger.error("VOD retention: object deletion failed", { vodId: vod.id, err });
    }
  }
  return { deleted, failed, objects };
}
