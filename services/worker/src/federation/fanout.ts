// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The fan-out (ADR 0030 decisions 3, 7 and 8): one outbox event becomes one activity, written to
 * `federation_objects` for a stable id, then one `deliver` job per distinct follower inbox.
 *
 * - `stream.online` → `Create{Note}`.
 * - `media.vod.state` / `media.clip.state` public → `Create{Video}`; not public, and the media
 *   was federated → `Delete{Tombstone}`.
 * - `moderation.restriction` restricted → `Delete` of that broadcast's `Note`.
 * - `channel.suspension` suspended → `Delete` of the actor to every follower inbox, then the
 *   followers are removed (recorded choice: remote followers are lost for good).
 * - `channel.update` while the streamer's setting is off → `Delete` of the actor, followers
 *   removed (the setting went off). Today `b7JobsFor` routes no `channel.update`; the sweep
 *   catches a channel turned off (`sweepDisabledActors`) until it does.
 *
 * Nothing happens unless `FEDERATION_ENABLED` and the channel federates now (both re-checked
 * here: a setting can change between the relay and this job). An object whose `Delete` went out
 * is never published again under the same id (Mastodon keeps a tombstone for it).
 */
import { EVENTS } from "@commonair/contracts/events";
import { vodPrefix } from "@commonair/contracts/storage";
import { type Executor, schema as s, uuidv7 } from "@commonair/db";
import {
  channelPageUrl,
  clipPageUrl,
  createActivity,
  deleteActorActivity,
  deleteObjectActivity,
  type FederationObjectKind,
  goLiveNote,
  mediaVideo,
  objectUrl,
  vodPageUrl,
} from "@commonair/federation";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { type FederationConfig, mediaUrl } from "./config.ts";
import { enqueueDeliveries } from "./deliver.ts";
import { federates, followerInboxes, type LocalChannel, loadChannel } from "./local.ts";

type SubjectKind = "broadcast" | "vod" | "clip";

export type FanoutOutcome =
  | "created"
  | "deleted"
  | "actor_deleted"
  /** Nothing to do (flag off, channel not federated, media not public, already handled). */
  | "skipped"
  /** The event is missing or not one the fan-out handles. */
  | "ignored";

export interface FanoutResult {
  outcome: FanoutOutcome;
  deliveries: number;
}

const SKIP: FanoutResult = { outcome: "skipped", deliveries: 0 };

type Ctx = Pick<WorkerContext, "db" | "logger" | "enqueueBulk" | "now">;

/** The stable object row for a subject, created on first publish. */
async function objectFor(
  db: Executor,
  channelId: string,
  kind: FederationObjectKind,
  subjectKind: SubjectKind,
  subjectId: string,
  now: Date,
): Promise<{ id: string; deletedAt: Date | null }> {
  await db
    .insert(s.federationObjects)
    .values({ id: uuidv7(), channelId, kind, subjectKind, subjectId, publishedAt: now })
    .onConflictDoNothing();
  const [row] = await db
    .select({ id: s.federationObjects.id, deletedAt: s.federationObjects.deletedAt })
    .from(s.federationObjects)
    .where(
      and(
        eq(s.federationObjects.kind, kind),
        eq(s.federationObjects.subjectKind, subjectKind),
        eq(s.federationObjects.subjectId, subjectId),
      ),
    );
  // Inserted or present just above.
  if (!row) throw new Error("federation object row missing after upsert");
  return row;
}

/** Mark a published object deleted (once) and return it; null when it was never published or is gone. */
async function claimDelete(
  db: Executor,
  kind: FederationObjectKind,
  subjectKind: SubjectKind,
  subjectId: string,
  now: Date,
): Promise<{ id: string } | null> {
  const [row] = await db
    .update(s.federationObjects)
    .set({ deletedAt: now })
    .where(
      and(
        eq(s.federationObjects.kind, kind),
        eq(s.federationObjects.subjectKind, subjectKind),
        eq(s.federationObjects.subjectId, subjectId),
        isNull(s.federationObjects.deletedAt),
      ),
    )
    .returning({ id: s.federationObjects.id });
  return row ?? null;
}

async function publish(
  ctx: Ctx,
  ch: LocalChannel,
  objectId: string,
  activity: ReturnType<typeof createActivity>,
): Promise<FanoutResult> {
  const inboxes = await followerInboxes(ctx.db, ch.id);
  const n = await enqueueDeliveries(ctx, ch.id, objectId, activity, inboxes);
  return { outcome: "created", deliveries: n };
}

async function sendDelete(
  ctx: Ctx,
  cfg: FederationConfig,
  ch: LocalChannel,
  kind: FederationObjectKind,
  subjectKind: SubjectKind,
  subjectId: string,
): Promise<FanoutResult> {
  const now = ctx.now();
  const row = await claimDelete(ctx.db, kind, subjectKind, subjectId, now);
  if (!row) return SKIP;
  const activity = deleteObjectActivity(ch.urls, objectUrl(cfg.site.publicUrl, row.id), kind, now);
  const n = await enqueueDeliveries(ctx, ch.id, row.id, activity, await followerInboxes(ctx.db, ch.id));
  return { outcome: "deleted", deliveries: n };
}

/**
 * `Delete` of the actor to every follower inbox, then the followers go. Used for suspension and
 * for a channel whose setting went off. The actor row (and key) stays for those two: the
 * deliveries sign with it. Account deletion has its own path (`deletion/federation.ts`).
 */
export async function deleteActor(ctx: Ctx, ch: LocalChannel): Promise<FanoutResult> {
  const inboxes = await followerInboxes(ctx.db, ch.id);
  const n = await enqueueDeliveries(ctx, ch.id, null, deleteActorActivity(ch.urls), inboxes);
  await ctx.db.delete(s.federationFollowers).where(eq(s.federationFollowers.channelId, ch.id));
  return { outcome: "actor_deleted", deliveries: n };
}

async function goLive(ctx: Ctx, cfg: FederationConfig, ch: LocalChannel, broadcastId: string): Promise<FanoutResult> {
  const [b] = await ctx.db
    .select({
      channelId: s.broadcasts.channelId,
      kind: s.broadcasts.kind,
      title: s.broadcasts.title,
      mature: s.broadcasts.mature,
      thumbnailKey: s.broadcasts.thumbnailKey,
      endedAt: s.broadcasts.endedAt,
      restrictedAt: s.broadcasts.restrictedAt,
      category: s.categories.name,
      categoryMature: s.categories.mature,
    })
    .from(s.broadcasts)
    .leftJoin(s.categories, eq(s.categories.id, s.broadcasts.categoryId))
    .where(eq(s.broadcasts.id, broadcastId));
  // A late job must never announce an ended, restricted or rehearsal broadcast.
  if (!b || b.channelId !== ch.id || b.kind !== "live" || b.endedAt !== null || b.restrictedAt !== null) return SKIP;
  const now = ctx.now();
  const row = await objectFor(ctx.db, ch.id, "note", "broadcast", broadcastId, now);
  if (row.deletedAt) return SKIP;
  const note = goLiveNote({
    id: objectUrl(cfg.site.publicUrl, row.id),
    actor: ch.urls,
    channelName: ch.displayName,
    channelUrl: channelPageUrl(cfg.site.publicUrl, ch.slug),
    title: b.title,
    category: b.category,
    thumbnailUrl: mediaUrl(cfg, b.thumbnailKey),
    mature: ch.mature || b.mature || (b.categoryMature ?? false),
    published: now,
    locale: cfg.site.defaultLocale,
  });
  return publish(ctx, ch, row.id, createActivity(note));
}

async function vodState(
  ctx: Ctx,
  cfg: FederationConfig,
  ch: LocalChannel,
  vodId: string,
  isPublic: boolean,
): Promise<FanoutResult> {
  if (!isPublic) return sendDelete(ctx, cfg, ch, "video", "vod", vodId);
  const [v] = await ctx.db
    .select({
      channelId: s.vods.channelId,
      title: s.vods.title,
      status: s.vods.status,
      visibility: s.vods.visibility,
      storagePrefix: s.vods.storagePrefix,
      durationSeconds: s.vods.durationSeconds,
      thumbnailKey: s.vods.thumbnailKey,
      removedReason: s.vods.removedReason,
      broadcastMature: s.broadcasts.mature,
    })
    .from(s.vods)
    .innerJoin(s.broadcasts, eq(s.broadcasts.id, s.vods.broadcastId))
    .where(eq(s.vods.id, vodId));
  // Re-read: only a VOD public right now federates (subscriber and private VODs never do).
  if (!v || v.channelId !== ch.id || v.status !== "ready" || v.visibility !== "public" || v.removedReason !== null)
    return SKIP;
  const now = ctx.now();
  const row = await objectFor(ctx.db, ch.id, "video", "vod", vodId, now);
  if (row.deletedAt) return SKIP;
  // Only a thumbnail under the public prefix has a public URL; a token URL never federates.
  const thumb = v.thumbnailKey?.startsWith(vodPrefix(vodId, "public")) ? mediaUrl(cfg, v.thumbnailKey) : null;
  const video = mediaVideo({
    id: objectUrl(cfg.site.publicUrl, row.id),
    actor: ch.urls,
    channelName: ch.displayName,
    title: v.title,
    durationSeconds: v.durationSeconds,
    watchUrl: vodPageUrl(cfg.site.publicUrl, ch.slug, vodId),
    thumbnailUrl: thumb,
    mature: ch.mature || v.broadcastMature,
    published: now,
    locale: cfg.site.defaultLocale,
  });
  return publish(ctx, ch, row.id, createActivity(video));
}

async function clipState(
  ctx: Ctx,
  cfg: FederationConfig,
  ch: LocalChannel,
  clipId: string,
  isPublic: boolean,
): Promise<FanoutResult> {
  if (!isPublic) return sendDelete(ctx, cfg, ch, "video", "clip", clipId);
  // Never `creatorId`: the clipper is a local user, and local users do not federate (decision 3).
  const [c] = await ctx.db
    .select({
      channelId: s.clips.channelId,
      title: s.clips.title,
      status: s.clips.status,
      durationSeconds: s.clips.durationSeconds,
      thumbnailKey: s.clips.thumbnailKey,
      removedReason: s.clips.removedReason,
      broadcastMature: s.broadcasts.mature,
    })
    .from(s.clips)
    .leftJoin(s.broadcasts, eq(s.broadcasts.id, s.clips.broadcastId))
    .where(eq(s.clips.id, clipId));
  if (!c || c.channelId !== ch.id || c.status !== "ready" || c.removedReason !== null) return SKIP;
  const now = ctx.now();
  const row = await objectFor(ctx.db, ch.id, "video", "clip", clipId, now);
  if (row.deletedAt) return SKIP;
  const video = mediaVideo({
    id: objectUrl(cfg.site.publicUrl, row.id),
    actor: ch.urls,
    channelName: ch.displayName,
    title: c.title,
    durationSeconds: c.durationSeconds,
    watchUrl: clipPageUrl(cfg.site.publicUrl, ch.slug, clipId),
    thumbnailUrl: mediaUrl(cfg, c.thumbnailKey),
    mature: ch.mature || (c.broadcastMature ?? false),
    published: now,
    locale: cfg.site.defaultLocale,
  });
  return publish(ctx, ch, row.id, createActivity(video));
}

/** Run the fan-out for one outbox event. */
export async function runFanout(eventId: string, ctx: Ctx, cfg: FederationConfig): Promise<FanoutResult> {
  if (!cfg.enabled) return SKIP;
  const [event] = await ctx.db
    .select({ type: s.events.type, channelId: s.events.channelId, payload: s.events.payload })
    .from(s.events)
    .where(eq(s.events.id, eventId));
  if (!event) {
    ctx.logger.warn("federation fan-out: no such event", { eventId });
    return { outcome: "ignored", deliveries: 0 };
  }
  const payloadChannel = (event.payload as { channel_id?: unknown } | null)?.channel_id;
  const channelId = typeof payloadChannel === "string" ? payloadChannel : event.channelId;
  if (!channelId) return { outcome: "ignored", deliveries: 0 };
  const ch = await loadChannel(ctx.db, cfg, channelId);
  if (!ch) return { outcome: "ignored", deliveries: 0 };

  switch (event.type) {
    case "channel.suspension": {
      const p = EVENTS["channel.suspension"].payload.parse(event.payload);
      // The suspension itself makes `federates` false; the actor and the setting are what count.
      if (!p.suspended || !ch.settingEnabled || !ch.actor?.enabled) return SKIP;
      return deleteActor(ctx, ch);
    }
    case "channel.update": {
      if (ch.settingEnabled || !ch.actor) return SKIP;
      return deleteActor(ctx, ch);
    }
    default:
      break;
  }
  if (!federates(cfg, ch)) return SKIP;

  switch (event.type) {
    case "stream.online": {
      const p = EVENTS["stream.online"].payload.parse(event.payload);
      return goLive(ctx, cfg, ch, p.id);
    }
    case "media.vod.state": {
      const p = EVENTS["media.vod.state"].payload.parse(event.payload);
      return vodState(ctx, cfg, ch, p.vod_id, p.public);
    }
    case "media.clip.state": {
      const p = EVENTS["media.clip.state"].payload.parse(event.payload);
      return clipState(ctx, cfg, ch, p.clip_id, p.public);
    }
    case "moderation.restriction": {
      const p = EVENTS["moderation.restriction"].payload.parse(event.payload);
      if (!p.restricted) return SKIP;
      return sendDelete(ctx, cfg, ch, "note", "broadcast", p.broadcast_id);
    }
    default:
      return { outcome: "ignored", deliveries: 0 };
  }
}
