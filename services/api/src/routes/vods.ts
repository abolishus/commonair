// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.*`: past broadcasts as media finalizes them. Listing and reading follow
 * `media/visibility.ts`. The owner renames, re-scopes and removes them (docs/testing/e6-selectors.md
 * "VODs and clips"): a removal hides the VOD and its broadcast's clips at once; the worker's
 * `vod-retention` deletes the objects later, unless the owner is under a legal hold.
 */
import { and, desc, eq, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { VOD_FAILED_REASONS } from "@commonair/contracts/enums";
import type { dto } from "@commonair/contracts";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { channelBySlug, iso, isoOrNull, mediaUrl } from "../lib/dto.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { channelAuthority, type Caller, type ChannelRole } from "../lib/access.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { audit } from "../events/audit.ts";
import { urlsWithheld, viewerAudience, vodShown, vodVisible } from "../media/visibility.ts";

const { broadcasts, channelRoles, channels, clips: clipsT, vods: vodsT } = schema;
type VodRow = typeof vodsT.$inferSelect;

/** Media writes the HLS playlist under the VOD's storage prefix (services/media vod/recorder.ts). */
const VOD_PLAYLIST = "index.m3u8";

const failedReason = (r: string | null) =>
  (VOD_FAILED_REASONS as readonly string[]).includes(r ?? "") ? (r as (typeof VOD_FAILED_REASONS)[number]) : null;

/** `withheld`: a mature VOD shown to someone who may not play it (`media/visibility.ts`). */
function toVod(deps: Deps, v: VodRow, channelSlug: string, withheld: boolean): z.infer<typeof dto.Vod> {
  const playable = v.status === "ready" && !withheld;
  return {
    id: v.id,
    channelSlug,
    title: v.title,
    status: v.status,
    visibility: v.visibility,
    durationSeconds: v.durationSeconds,
    thumbnailUrl: withheld ? null : mediaUrl(deps, v.thumbnailKey),
    playlistUrl: playable ? mediaUrl(deps, `${v.storagePrefix.replace(/\/?$/, "/")}${VOD_PLAYLIST}`) : null,
    createdAt: iso(v.createdAt),
    expiresAt: isoOrNull(v.expiresAt),
    failedReason: v.status === "failed" ? failedReason(v.failedReason) : null,
  };
}

export const vods = {
  list: os.vods.list.handler(async ({ context, input }) => {
    const { deps } = context;
    const channel = await channelBySlug(deps, input.channel);
    if (!channel) throw notFound("Channel not found");
    const audience = await viewerAudience(deps, context.caller, channel);
    if (audience !== "owner" && channel.suspendedAt !== null) return { items: [], nextCursor: null };
    const cur = decodeCursor(input.cursor, isKeyCursor);
    let after: SQL | undefined;
    if (cur) {
      const t = new Date(cur.t);
      after = or(lt(vodsT.createdAt, t), and(eq(vodsT.createdAt, t), lt(vodsT.id, cur.id)));
    }
    const rows = await deps.db
      .select({ v: vodsT, b: { mature: broadcasts.mature, categoryId: broadcasts.categoryId } })
      .from(vodsT)
      .innerJoin(broadcasts, eq(broadcasts.id, vodsT.broadcastId))
      .where(and(eq(vodsT.channelId, channel.id), vodVisible(audience), after))
      .orderBy(desc(vodsT.createdAt), desc(vodsT.id))
      .limit(input.limit + 1);
    const withheld = await urlsWithheld(
      deps,
      context.caller,
      channel,
      rows.map((r) => r.b),
    );
    const indexed = rows.map((r, i) => ({ ...r, withheld: withheld[i] ?? true }));
    return pageOf(
      indexed,
      input.limit,
      (r) => toVod(deps, r.v, channel.slug, r.withheld),
      (last) => encodeCursor({ t: iso(last.v.createdAt), id: last.v.id }),
    );
  }),

  get: os.vods.get.handler(async ({ context, input }) => {
    const { deps } = context;
    const [row] = await deps.db
      .select({ v: vodsT, channel: channels, b: broadcasts })
      .from(vodsT)
      .innerJoin(broadcasts, eq(broadcasts.id, vodsT.broadcastId))
      .innerJoin(channels, eq(channels.id, vodsT.channelId))
      .where(eq(vodsT.id, input.id))
      .limit(1);
    if (
      !row ||
      !vodShown(await viewerAudience(deps, context.caller, row.channel), row.v, row.channel, row.b.restrictedAt)
    )
      throw notFound("VOD not found");
    const [withheld] = await urlsWithheld(deps, context.caller, row.channel, [row.b]);
    return toVod(deps, row.v, row.channel.slug, withheld ?? true);
  }),

  update: os.vods.update.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const row = await managedVod(deps, caller, input.id);
    const title = input.title?.trim();
    if (title === "") throw badRequest("The title cannot be blank");
    const set: Partial<typeof vodsT.$inferInsert> = {};
    if (title !== undefined) set.title = title;
    if (input.visibility !== undefined) set.visibility = input.visibility;
    if (Object.keys(set).length === 0) return toVod(deps, row.v, row.channel.slug, false);
    const updated = await deps.db.transaction(async (tx) => {
      const [v] = await tx
        .update(vodsT)
        .set({ ...set, updatedAt: deps.now() })
        // Compare-and-set: a VOD removed meanwhile stays removed.
        .where(and(eq(vodsT.id, row.v.id), ne(vodsT.status, "deleted"), isNull(vodsT.removedReason)))
        .returning();
      if (!v) throw notFound("VOD not found");
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "vod.update",
        subjectType: "vod",
        subjectId: v.id,
        channelId: v.channelId,
        details: { titleChanged: title !== undefined, visibility: input.visibility ?? null },
      });
      return v;
    });
    return toVod(deps, updated, row.channel.slug, false);
  }),

  remove: os.vods.remove.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const row = await managedVod(deps, caller, input.id);
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      const [v] = await tx
        .update(vodsT)
        .set({ removedReason: "owner", expiresAt: now, updatedAt: now })
        .where(and(eq(vodsT.id, row.v.id), ne(vodsT.status, "deleted"), isNull(vodsT.removedReason)))
        .returning({ id: vodsT.id, broadcastId: vodsT.broadcastId, channelId: vodsT.channelId });
      if (!v) throw notFound("VOD not found");
      // The broadcast's clips go with it (the clip shows the VOD's content).
      const removedClips = await tx
        .update(clipsT)
        .set({ removedReason: "owner" })
        .where(
          and(
            or(eq(clipsT.broadcastId, v.broadcastId), eq(clipsT.vodId, v.id)),
            ne(clipsT.status, "deleted"),
            isNull(clipsT.removedReason),
          ),
        )
        .returning({ id: clipsT.id });
      await audit(tx, {
        actorType: "user",
        actorId: caller.user.id,
        action: "vod.remove",
        subjectType: "vod",
        subjectId: v.id,
        channelId: v.channelId,
        details: { clips: removedClips.length },
      });
    });
    return { ok: true as const };
  }),
};

/**
 * A VOD the caller may manage (the channel owner or an editor). Anything else, including a removed
 * VOD or another channel's, is `NOT_FOUND`: managing must not reveal that a VOD exists.
 */
async function managedVod(deps: Deps, caller: Caller, id: string) {
  const [row] = await deps.db
    .select({ v: vodsT, channel: channels, restrictedAt: broadcasts.restrictedAt })
    .from(vodsT)
    .innerJoin(broadcasts, eq(broadcasts.id, vodsT.broadcastId))
    .innerJoin(channels, eq(channels.id, vodsT.channelId))
    .where(eq(vodsT.id, id))
    .limit(1);
  if (!row) throw notFound("VOD not found");
  const roles: ChannelRole[] =
    row.channel.ownerId === caller.user.id
      ? []
      : (
          await deps.db
            .select({ role: channelRoles.role })
            .from(channelRoles)
            .where(and(eq(channelRoles.channelId, row.channel.id), eq(channelRoles.userId, caller.user.id)))
        ).map((r) => r.role);
  const authority = channelAuthority(caller, row.channel, roles);
  if (authority !== "owner" && authority !== "editor") throw notFound("VOD not found");
  if (!vodShown("owner", row.v, row.channel, row.restrictedAt)) throw notFound("VOD not found");
  return row;
}
