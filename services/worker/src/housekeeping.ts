// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Housekeeping: expiry, pruning, stale-session closing, relay liveness, VOD retention. */
import { KEYS } from "@commonair/contracts/internal";
import { vodPrefix as contractVodPrefix } from "@commonair/contracts/storage";
import { lockLegalHold, schema, uuidv7, type Executor } from "@commonair/db";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { WorkerContext } from "./context.ts";
import { dmcaHiddenKey } from "./dmca/objects.ts";

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

/**
 * The only object prefix a VOD may own today (trailing slash: "vods/a" must never match "vods/ab…").
 * A one-argument wrapper over the contract until W0-media-exposure switches callers to placements.
 */
export const vodPrefix = (vodId: string) => contractVodPrefix(vodId, "public");

/** The only object keys a clip may own: `clips/<clip id>.<ext>` (video and thumbnail). */
export const isOwnClipKey = (clipId: string, key: string) =>
  key.startsWith(`clips/${clipId}.`) && /^clips\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(key);

/** Removals by the owner or the clip's creator (e6 spec "VODs and clips"); retention deletes their objects. */
export const USER_REMOVED_REASONS = ["owner", "creator"] as const;

/**
 * True while the channel's owner has an active legal hold (ADR 0006): their media is never
 * deleted, whatever removed or expired it.
 */
const ownerHeld = (channelId: typeof schema.vods.channelId | typeof schema.clips.channelId) =>
  sql`exists (select 1 from ${schema.legalHolds} h join ${schema.channels} c on c.owner_id = h.user_id
               where c.id = ${channelId} and h.released_at is null)`;

/**
 * Run `remove` for one of a channel's media rows unless its owner is held, re-checked right
 * before the objects go (the batch was chosen earlier: a hold placed meanwhile must still win).
 * Returns true when the row was skipped as held.
 */
async function unlessOwnerHeld(
  ctx: WorkerContext,
  channelId: string,
  remove: (tx: Executor) => Promise<void>,
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ id: schema.channels.ownerId })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId));
    if (owner) {
      // Placing a hold takes the same lock (`lockLegalHold`), so the re-check below cannot miss one.
      await lockLegalHold(tx, owner.id);
      const [hold] = await tx
        .select({ id: schema.legalHolds.id })
        .from(schema.legalHolds)
        .where(and(eq(schema.legalHolds.userId, owner.id), isNull(schema.legalHolds.releasedAt)))
        .limit(1);
      if (hold) return true;
    }
    await remove(tx);
    return false;
  });
}

/**
 * Expired VODs (retention, or removed by their owner: the API expires them at once) and clips
 * removed by their owner or creator: delete their objects, then mark them deleted. A VOD or clip
 * whose objects could not be deleted keeps its status and is retried next run. While the channel
 * owner has an active legal hold nothing of theirs is deleted: those rows count as `held`.
 */
export async function enforceVodRetention(ctx: WorkerContext, batch = 50) {
  const v = schema.vods;
  if (!ctx.storage) {
    ctx.logger.warn("VOD retention skipped: object storage is not configured");
    return { deleted: 0, failed: 0, objects: 0, held: 0, clipsDeleted: 0 };
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
  const [heldVods] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(v)
    .where(and(due, ownPrefix, ownerHeld(v.channelId)));
  // Refused and held rows are excluded here so they can never starve valid ones out of the batch.
  const expired = await ctx.db
    .select({ id: v.id, channelId: v.channelId })
    .from(v)
    .where(and(due, ownPrefix, sql`not ${ownerHeld(v.channelId)}`))
    .orderBy(v.expiresAt)
    .limit(batch);
  let deleted = 0;
  let failed = refused.length;
  let objects = 0;
  let heldLate = 0;
  const storage = ctx.storage;
  for (const vod of expired) {
    try {
      const held = await unlessOwnerHeld(ctx, vod.channelId, async (tx) => {
        objects += await storage.deletePrefix(ctx.mediaBucket, vodPrefix(vod.id));
        // A DMCA takedown keeps its copy under moderation/dmca/; expiry ends that too.
        objects += await storage.deletePrefix(ctx.mediaBucket, dmcaHiddenKey(vodPrefix(vod.id)));
        // An owner removal keeps its reason; only plain expiry is recorded as retention.
        await tx
          .update(v)
          .set({ status: "deleted", removedReason: sql`coalesce(${v.removedReason}, 'retention')` })
          .where(eq(v.id, vod.id));
      });
      if (held) heldLate++;
      else deleted++;
    } catch (err) {
      failed++;
      ctx.logger.error("VOD retention: object deletion failed", { vodId: vod.id, err });
    }
  }
  const clips = await purgeRemovedClips(ctx, batch);
  return {
    deleted,
    failed: failed + clips.failed,
    objects: objects + clips.objects,
    held: (heldVods?.n ?? 0) + heldLate + clips.held,
    clipsDeleted: clips.deleted,
  };
}

/** Clips removed by their owner or creator: delete the clip and thumbnail objects, then mark them deleted. */
async function purgeRemovedClips(ctx: WorkerContext, batch: number) {
  const c = schema.clips;
  const out = { deleted: 0, failed: 0, objects: 0, held: 0 };
  const storage = ctx.storage;
  if (!storage) return out;
  const removed = and(inArray(c.removedReason, [...USER_REMOVED_REASONS]), ne(c.status, "deleted"));
  const [held] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(c)
    .where(and(removed, ownerHeld(c.channelId)));
  out.held = held?.n ?? 0;
  // Same rule as VOD prefixes: a key the media unit would not have written is never deleted, and
  // such rows are kept out of the batch so they cannot starve valid ones.
  const ownKey = (col: typeof c.storageKey | typeof c.thumbnailKey) =>
    sql`(${col} is null or ${col} ~ ('^clips/' || ${c.id}::text || '\\.[a-z0-9]{2,5}$'))`;
  const ownKeys = and(ownKey(c.storageKey), ownKey(c.thumbnailKey));
  const refused = await ctx.db
    .select({ id: c.id })
    .from(c)
    .where(and(removed, sql`not ${ownerHeld(c.channelId)}`, sql`not (${ownKeys})`))
    .limit(batch);
  for (const r of refused) ctx.logger.error("VOD retention: refusing unexpected clip object key", { clipId: r.id });
  out.failed += refused.length;
  const due = await ctx.db
    .select({ id: c.id, channelId: c.channelId, storageKey: c.storageKey, thumbnailKey: c.thumbnailKey })
    .from(c)
    .where(and(removed, sql`not ${ownerHeld(c.channelId)}`, ownKeys))
    .orderBy(c.createdAt)
    .limit(batch);
  for (const clip of due) {
    const keys = [clip.storageKey, clip.thumbnailKey].filter((k): k is string => k !== null);
    // Checked again here, so a regex slip in SQL can never widen what gets deleted.
    if (keys.some((k) => !isOwnClipKey(clip.id, k))) {
      out.failed++;
      continue;
    }
    try {
      const held = await unlessOwnerHeld(ctx, clip.channelId, async (tx) => {
        for (const k of keys) await storage.delete(ctx.mediaBucket, k);
        await tx.update(c).set({ status: "deleted" }).where(eq(c.id, clip.id));
      });
      if (held) {
        out.held++;
        continue;
      }
      out.objects += keys.length;
      out.deleted++;
    } catch (err) {
      out.failed++;
      ctx.logger.error("VOD retention: clip object deletion failed", { clipId: clip.id, err });
    }
  }
  return out;
}
