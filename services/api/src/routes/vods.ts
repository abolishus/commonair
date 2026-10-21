// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.*`: past broadcasts as media finalizes them. Listing and reading follow
 * `media/visibility.ts`; renaming and deleting are not implemented yet (HTTP 501, milestone E6:
 * deleting has to respect legal holds and evidence retention).
 */
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { VOD_FAILED_REASONS } from "@commonair/contracts/enums";
import type { dto } from "@commonair/contracts";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { channelBySlug, iso, isoOrNull, mediaUrl } from "../lib/dto.ts";
import { notFound, notImplemented } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { audienceOf, urlsWithheld, vodShown, vodVisible } from "../media/visibility.ts";

const { broadcasts, channels, vods: vodsT } = schema;
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
    const audience = audienceOf(context.caller, channel);
    if (audience === "public" && channel.suspendedAt !== null) return { items: [], nextCursor: null };
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
    if (!row || !vodShown(audienceOf(context.caller, row.channel), row.v, row.channel, row.b.restrictedAt))
      throw notFound("VOD not found");
    const [withheld] = await urlsWithheld(deps, context.caller, row.channel, [row.b]);
    return toVod(deps, row.v, row.channel.slug, withheld ?? true);
  }),

  update: os.vods.update.handler(notImplemented),
  remove: os.vods.remove.handler(notImplemented),
};
