// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `clips.*`: a clip row starts `processing` and is cut by media (`QUEUES.clips`), which PDQ-checks
 * every second of it before publishing; a match removes it as T0 and it is never shown. Listing and
 * reading follow `media/visibility.ts`. The channel's owner (or an editor or moderator) and the clip's
 * creator may delete it: hidden at once, objects deleted by the worker's `vod-retention` (E6).
 */
import { and, desc, eq, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { channelAuthority, type Caller } from "../lib/access.ts";
import { decodeCursor, encodeCursor, isKeyCursor, isOffsetCursor } from "../lib/cursor.ts";
import { channelBySlug, iso, loadUsersPublic, mediaUrl } from "../lib/dto.ts";
import { notFound, precondition } from "../lib/errors.ts";
import { audit } from "../events/audit.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { clipQueue } from "../media/clip-queue.ts";
import { clipVisible, urlsWithheld, viewerAudience, vodShown } from "../media/visibility.ts";
import { matureGate } from "./playback.ts";
import { clipChat } from "../chat-replay/handlers.ts";

const { broadcasts, channelRoles, channels, clips: clipsT, vods } = schema;
type ClipRow = typeof clipsT.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;
type Clip = z.infer<typeof dto.Clip>;
type Labelled = { mature: boolean; categoryId: string | null };

/**
 * A live clip ends this far behind the live edge: what viewers just saw (HLS plays seconds behind),
 * and what media's recorder already has on disk (4 s segments, polled every second, pulled from
 * MediaMTX). Cutting up to "now" finds no finished segment and the clip fails.
 */
export const LIVE_CLIP_LAG_SECONDS = 10;

/** `labels[i]` is clip i's broadcast (null when gone); mature media URLs follow the 18+ gate. */
async function toClips(
  deps: Deps,
  caller: Caller | null,
  channel: ChannelRow,
  rows: readonly ClipRow[],
  labels: readonly (Labelled | null)[],
): Promise<Clip[]> {
  const [creators, withheld] = await Promise.all([
    loadUsersPublic(
      deps,
      rows.map((r) => r.creatorId).filter((id): id is string => id !== null),
    ),
    urlsWithheld(deps, caller, channel, labels),
  ]);
  return rows.map((c, i) => {
    const u = c.creatorId ? creators.get(c.creatorId) : undefined;
    const playable = c.status === "ready" && !(withheld[i] ?? true);
    return {
      id: c.id,
      channelSlug: channel.slug,
      title: c.title,
      creator: u ? { id: u.id, username: u.username, displayName: u.displayName } : null,
      status: c.status,
      durationSeconds: c.durationSeconds,
      url: playable ? mediaUrl(deps, c.storageKey) : null,
      thumbnailUrl: playable ? mediaUrl(deps, c.thumbnailKey) : null,
      views: c.views,
      createdAt: iso(c.createdAt),
    };
  });
}

const labelsOf = (b: Labelled | null) => (b ? { mature: b.mature, categoryId: b.categoryId } : null);

/** Where the cut starts, in seconds from the start of the broadcast, and which broadcast. */
async function clipSource(
  deps: Deps,
  caller: Caller,
  channel: ChannelRow,
  input: { vodId?: string | undefined; startOffset?: number | undefined; durationSeconds: number },
): Promise<{ broadcastId: string; vodId: string | null; startOffset: number; labels: Labelled }> {
  if (input.vodId) {
    const [row] = await deps.db
      .select({ v: vods, b: broadcasts })
      .from(vods)
      .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
      .where(and(eq(vods.id, input.vodId), eq(vods.channelId, channel.id)))
      .limit(1);
    if (!row || !vodShown(await viewerAudience(deps, caller, channel), row.v, channel, row.b.restrictedAt))
      throw notFound("VOD not found");
    if (row.v.status !== "ready") throw precondition("vod_ready", "The VOD is not ready yet");
    const start = input.startOffset ?? 0;
    if (start + input.durationSeconds > row.v.durationSeconds)
      throw precondition("within_vod", "The clip must lie within the VOD");
    return { broadcastId: row.v.broadcastId, vodId: row.v.id, startOffset: start, labels: row.b };
  }
  // The broadcast playback serves, so a stale unended row is never clipped.
  const [live] = channel.liveBroadcastId
    ? await deps.db.select().from(broadcasts).where(eq(broadcasts.id, channel.liveBroadcastId))
    : [];
  if (!live || live.endedAt) throw precondition("live", "The channel is not live; clip a VOD instead");
  // A broadcast under review cannot be clipped: its clips would be hidden until the case closes.
  if (live.restrictedAt !== null) throw precondition("not_under_review", "This stream is under review");
  const elapsed = (deps.now().getTime() - live.startedAt.getTime()) / 1000;
  const end = Math.max(0, elapsed - LIVE_CLIP_LAG_SECONDS);
  return { broadcastId: live.id, vodId: null, startOffset: Math.max(0, end - input.durationSeconds), labels: live };
}

export const clips = {
  create: os.clips.create.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const channel = await channelBySlug(deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    if (channel.suspendedAt !== null) throw precondition("channel_active", "This channel is suspended");
    const src = await clipSource(deps, caller, channel, input);
    // Whoever may not watch it may not clip it.
    const [withheld] = await urlsWithheld(deps, caller, channel, [src.labels]);
    if (withheld) throw matureGate();
    const [row] = await deps.db
      .insert(clipsT)
      .values({
        channelId: channel.id,
        broadcastId: src.broadcastId,
        vodId: src.vodId,
        creatorId: caller.user.id,
        title: input.title,
        startOffset: src.startOffset,
        durationSeconds: input.durationSeconds,
      })
      .returning();
    if (!row) throw new Error("clip insert returned no row");
    try {
      await clipQueue(deps).enqueue(row.id);
    } catch (err) {
      deps.logger.error("clip enqueue failed", { clipId: row.id, err: (err as Error).name });
      // Never leave a clip `processing` forever when media will not hear of it. Media skips a
      // clip that is no longer `processing`, so a job that did land is harmless.
      await deps.db
        .update(clipsT)
        .set({ status: "failed" })
        .where(eq(clipsT.id, row.id))
        .catch((e: unknown) => deps.logger.error("clip fail-mark failed", { clipId: row.id, err: (e as Error).name }));
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Clipping is unavailable right now; try again" });
    }
    const [out] = await toClips(deps, caller, channel, [row], [labelsOf(src.labels)]);
    return out as Clip;
  }),

  list: os.clips.list.handler(async ({ context, input }) => {
    const { deps } = context;
    const channel = await channelBySlug(deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    const audience = await viewerAudience(deps, context.caller, channel);
    if (audience !== "owner" && channel.suspendedAt !== null) return { items: [], nextCursor: null };
    const top = input.sort === "top";
    // "top" pages by offset (views change between pages); "recent" by keyset.
    let after: SQL | undefined;
    let offset = 0;
    if (top) {
      offset = decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0;
    } else {
      const cur = decodeCursor(input.cursor, isKeyCursor);
      if (cur) {
        const t = new Date(cur.t);
        after = or(lt(clipsT.createdAt, t), and(eq(clipsT.createdAt, t), lt(clipsT.id, cur.id)));
      }
    }
    const rows = await deps.db
      .select({ c: clipsT, mature: broadcasts.mature, categoryId: broadcasts.categoryId, bid: broadcasts.id })
      .from(clipsT)
      .leftJoin(broadcasts, eq(broadcasts.id, clipsT.broadcastId))
      .where(and(eq(clipsT.channelId, channel.id), clipVisible(audience), after))
      .orderBy(...(top ? [desc(clipsT.views)] : []), desc(clipsT.createdAt), desc(clipsT.id))
      .limit(input.limit + 1)
      .offset(offset);
    const page = rows.slice(0, input.limit);
    const items = await toClips(
      deps,
      context.caller,
      channel,
      page.map((r) => r.c),
      page.map((r) => (r.bid === null ? null : { mature: r.mature ?? false, categoryId: r.categoryId })),
    );
    const last = page[page.length - 1]?.c;
    const nextCursor =
      rows.length > input.limit && last
        ? top
          ? encodeCursor({ o: offset + input.limit })
          : encodeCursor({ t: iso(last.createdAt), id: last.id })
        : null;
    return { items, nextCursor };
  }),

  get: os.clips.get.handler(async ({ context, input }) => {
    const { deps } = context;
    const [head] = await deps.db
      .select({ channel: channels })
      .from(clipsT)
      .innerJoin(channels, eq(channels.id, clipsT.channelId))
      .where(eq(clipsT.id, input.id))
      .limit(1);
    if (!head) throw notFound("Clip not found");
    const audience = await viewerAudience(deps, context.caller, head.channel);
    if (audience !== "owner" && head.channel.suspendedAt !== null) throw notFound("Clip not found");
    const [row] = await deps.db
      .select({ c: clipsT, mature: broadcasts.mature, categoryId: broadcasts.categoryId, bid: broadcasts.id })
      .from(clipsT)
      .leftJoin(broadcasts, eq(broadcasts.id, clipsT.broadcastId))
      .where(and(eq(clipsT.id, input.id), clipVisible(audience)))
      .limit(1);
    if (!row) throw notFound("Clip not found");
    const labels = row.bid === null ? null : { mature: row.mature ?? false, categoryId: row.categoryId };
    const [out] = await toClips(deps, context.caller, head.channel, [row.c], [labels]);
    return out as Clip;
  }),

  remove: os.clips.remove.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const [head] = await deps.db
      .select({ c: clipsT, channel: channels })
      .from(clipsT)
      .innerJoin(channels, eq(channels.id, clipsT.channelId))
      .where(eq(clipsT.id, input.id))
      .limit(1);
    // Anything the caller may not delete reads as missing: no existence leak.
    if (!head) throw notFound("Clip not found");
    const roles =
      head.channel.ownerId === caller.user.id
        ? []
        : (
            await deps.db
              .select({ role: channelRoles.role })
              .from(channelRoles)
              .where(and(eq(channelRoles.channelId, head.channel.id), eq(channelRoles.userId, caller.user.id)))
          ).map((r) => r.role);
    const channelSide = channelAuthority(caller, head.channel, roles) !== null;
    const creator = head.c.creatorId !== null && head.c.creatorId === caller.user.id;
    if (!channelSide && !creator) throw notFound("Clip not found");
    // Hidden from the owner too (removed, restricted, or its VOD removed): nothing left to delete.
    const [visible] = await deps.db
      .select({ id: clipsT.id })
      .from(clipsT)
      .leftJoin(broadcasts, eq(broadcasts.id, clipsT.broadcastId))
      .where(and(eq(clipsT.id, input.id), clipVisible("owner")))
      .limit(1);
    if (!visible) throw notFound("Clip not found");
    const reason = channelSide ? "owner" : "creator";
    await deps.db.transaction(async (tx) => {
      const [c] = await tx
        .update(clipsT)
        .set({ removedReason: reason })
        .where(and(eq(clipsT.id, input.id), ne(clipsT.status, "deleted"), isNull(clipsT.removedReason)))
        .returning({ id: clipsT.id });
      if (!c) throw notFound("Clip not found");
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "clip.remove",
        subjectType: "clip",
        subjectId: c.id,
        channelId: head.channel.id,
        details: { by: reason },
      });
    });
    return { ok: true as const };
  }),
  chat: clipChat,
};
