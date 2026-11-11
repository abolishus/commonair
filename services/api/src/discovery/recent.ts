// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cross-channel shelves (overhaul wave 2, D3.1): home's "Catch up" (`vods.listRecent`) and
 * "Fresh clips" (`clips.listRecent`). Both show only what an anonymous caller may watch (the public
 * audience of `media/visibility.ts`: ready, public, nothing removed or restricted), never a
 * suspended channel or a banned owner's, and the owner sees nothing more here than anyone else.
 *
 * Mature media (its broadcast, its channel, or either one's category labelled mature) is left out
 * unless the caller asks for it and is a confirmed adult. A home shelf of cards with their
 * thumbnails withheld helps nobody, so unlike `listByCategory` nothing is listed without its URLs.
 */
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { VOD_PLAYLIST, VOD_ROUTE, vodPlacement, vodPrefix } from "@commonair/contracts/storage";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import type { Caller } from "../lib/access.ts";
import { decodeCursor, encodeCursor, isKeyCursor, isOffsetCursor } from "../lib/cursor.ts";
import { channelAvatar, channelTheme, iso, isoOrNull, loadUsersPublic, mediaUrl } from "../lib/dto.ts";
import { vodCaptionTracks } from "../captions/tracks.ts";
import { channelCategory, clipVisible, vodVisible } from "../media/visibility.ts";
import { confirmedAdult } from "../routes/me.ts";
import { mintVodToken } from "../routes/vods.ts";

const { broadcasts, categories, channels, clips, users, vods } = schema;
type VodCard = z.infer<typeof dto.VodCard>;
type ClipCard = z.infer<typeof dto.ClipCard>;
type ChannelRow = typeof channels.$inferSelect;
type VodRow = typeof vods.$inferSelect;
type CardChannel = VodCard["channel"];

/** The broadcast's own category (the card's label); the channel's own is `channelCategory`. */
const broadcastCategory = alias(categories, "broadcast_category");

/** What both shelves select besides the item: its channel, the owner's image and the broadcast's category. */
const around = {
  channel: channels,
  ownerImage: users.image,
  cat: { slug: broadcastCategory.slug, name: broadcastCategory.name },
};

/** Clip windows, measured against the database clock (as `clips.list`). */
const RANGE_DAYS: Record<"7d" | "30d", number> = { "7d": 7, "30d": 30 };

export interface RecentInput {
  cursor?: string | undefined;
  limit: number;
  language?: string | undefined;
  includeMature: boolean;
}

export interface RecentClipsInput extends RecentInput {
  sort: "recent" | "top";
  range: "7d" | "30d" | "all";
}

/** May this caller see mature media in a cross-channel shelf? Asked for, and a confirmed adult. */
export async function matureAllowed(deps: Deps, caller: Caller | null, includeMature: boolean): Promise<boolean> {
  return includeMature && (await confirmedAdult(deps, caller?.user.id));
}

/**
 * Not labelled mature by the broadcast, the channel, the channel's category or the broadcast's
 * category, over a query joining all four (the last two left-joined).
 */
export const notMature = (): SQL =>
  and(
    eq(broadcasts.mature, false),
    eq(channels.mature, false),
    sql`coalesce(${channelCategory.mature}, false) = false`,
    sql`coalesce(${broadcastCategory.mature}, false) = false`,
  ) as SQL;

/** Listed channels only: not suspended, owner not banned, and (optionally) in one language. */
const listedChannel = (language: string | undefined): SQL =>
  and(
    isNull(channels.suspendedAt),
    eq(users.banned, false),
    language ? eq(channels.language, language) : undefined,
  ) as SQL;

/** The card's channel block, as the directory builds it. */
export function cardChannel(deps: Deps, c: ChannelRow, ownerImage: string | null): CardChannel {
  return {
    id: c.id,
    slug: c.slug,
    displayName: c.displayName,
    avatarUrl: channelAvatar(deps, c, ownerImage),
    accent: channelTheme(c).accent,
  };
}

/** Newest first on (created_at, id), from a keyset cursor. */
function keysetAfter(cursor: string | undefined, col: { createdAt: AnyPgColumn; id: AnyPgColumn }): SQL | undefined {
  const cur = decodeCursor(cursor, isKeyCursor);
  if (!cur) return undefined;
  const t = new Date(cur.t);
  return or(lt(col.createdAt, t), and(eq(col.createdAt, t), lt(col.id, cur.id)));
}

/**
 * Playback for a VOD the public may watch: from `/media` once its objects are under the public
 * prefix, else a token-checked `/vod/` URL while they move (as `vods.list` does).
 */
async function vodUrls(
  deps: Deps,
  v: VodRow,
  channelId: string,
): Promise<{ thumbnailUrl: string | null; playlistUrl: string | null }> {
  const state = {
    status: v.status,
    visibility: v.visibility,
    removedReason: v.removedReason,
    broadcastRestricted: false,
    channelSuspended: false,
    nciiHidden: false,
    dmcaHidden: false,
  };
  if (vodPlacement(state) === "public" && v.storagePrefix === vodPrefix(v.id, "public")) {
    return {
      thumbnailUrl: mediaUrl(deps, v.thumbnailKey),
      playlistUrl: mediaUrl(deps, `${v.storagePrefix}${VOD_PLAYLIST}`),
    };
  }
  const t = encodeURIComponent(await mintVodToken(deps, v, channelId));
  const base = `${deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "")}${VOD_ROUTE}${v.id}/`;
  const thumbFile = v.thumbnailKey?.startsWith(v.storagePrefix) ? v.thumbnailKey.slice(v.storagePrefix.length) : null;
  return {
    playlistUrl: `${base}${VOD_PLAYLIST}?t=${t}`,
    thumbnailUrl: thumbFile ? `${base}${thumbFile.split("/").map(encodeURIComponent).join("/")}?t=${t}` : null,
  };
}

/** `vods.listRecent`: public, ready videos across every channel, newest first. */
export async function listRecentVods(
  deps: Deps,
  caller: Caller | null,
  input: RecentInput,
): Promise<{ items: VodCard[]; nextCursor: string | null }> {
  const mature = await matureAllowed(deps, caller, input.includeMature);
  const rows = await deps.db
    .select({ v: vods, ...around })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(broadcastCategory, eq(broadcastCategory.id, broadcasts.categoryId))
    .leftJoin(channelCategory, eq(channelCategory.id, channels.categoryId))
    .where(
      and(
        vodVisible("public"),
        listedChannel(input.language),
        mature ? undefined : notMature(),
        keysetAfter(input.cursor, vods),
      ),
    )
    .orderBy(desc(vods.createdAt), desc(vods.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const items = await Promise.all(
    page.map(async (r): Promise<VodCard> => {
      const urls = await vodUrls(deps, r.v, r.channel.id);
      return {
        id: r.v.id,
        channelSlug: r.channel.slug,
        title: r.v.title,
        status: r.v.status,
        visibility: r.v.visibility,
        durationSeconds: r.v.durationSeconds,
        thumbnailUrl: urls.thumbnailUrl,
        playlistUrl: urls.playlistUrl,
        createdAt: iso(r.v.createdAt),
        expiresAt: isoOrNull(r.v.expiresAt),
        failedReason: null,
        category: r.cat?.slug ? { slug: r.cat.slug, name: r.cat.name } : null,
        captions: await vodCaptionTracks(deps, r.v),
        channel: cardChannel(deps, r.channel, r.ownerImage),
      };
    }),
  );
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > input.limit && last ? encodeCursor({ t: iso(last.v.createdAt), id: last.v.id }) : null,
  };
}

/** `clips.listRecent`: ready clips of public broadcasts across every channel. */
export async function listRecentClips(
  deps: Deps,
  caller: Caller | null,
  input: RecentClipsInput,
): Promise<{ items: ClipCard[]; nextCursor: string | null }> {
  const mature = await matureAllowed(deps, caller, input.includeMature);
  const top = input.sort === "top";
  // "top" pages by offset (views change between pages), "recent" by keyset.
  const offset = top ? (decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0) : 0;
  const after = top ? undefined : keysetAfter(input.cursor, clips);
  const range =
    input.range === "all"
      ? undefined
      : sql`${clips.createdAt} >= now() - make_interval(days => ${RANGE_DAYS[input.range]})`;
  const rows = await deps.db
    .select({ c: clips, startedAt: broadcasts.startedAt, ...around })
    .from(clips)
    .innerJoin(broadcasts, eq(broadcasts.id, clips.broadcastId))
    .innerJoin(channels, eq(channels.id, clips.channelId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(broadcastCategory, eq(broadcastCategory.id, broadcasts.categoryId))
    .leftJoin(channelCategory, eq(channelCategory.id, channels.categoryId))
    .where(
      and(
        clipVisible("public"),
        // A rehearsal is never published, its clips included (decisions (f), (g)).
        eq(broadcasts.kind, "live"),
        listedChannel(input.language),
        mature ? undefined : notMature(),
        range,
        after,
      ),
    )
    .orderBy(...(top ? [desc(clips.views)] : []), desc(clips.createdAt), desc(clips.id))
    .limit(input.limit + 1)
    .offset(offset);
  const page = rows.slice(0, input.limit);
  const creators = await loadUsersPublic(
    deps,
    page.map((r) => r.c.creatorId).filter((id): id is string => id !== null),
  );
  const items = page.map((r): ClipCard => {
    const u = r.c.creatorId ? creators.get(r.c.creatorId) : undefined;
    return {
      id: r.c.id,
      channelSlug: r.channel.slug,
      title: r.c.title,
      creator: u ? { id: u.id, username: u.username, displayName: u.displayName } : null,
      status: r.c.status,
      durationSeconds: r.c.durationSeconds,
      url: mediaUrl(deps, r.c.storageKey),
      thumbnailUrl: mediaUrl(deps, r.c.thumbnailKey),
      views: r.c.views,
      createdAt: iso(r.c.createdAt),
      windowStartedAt: new Date(r.startedAt.getTime() + r.c.startOffset * 1000).toISOString(),
      category: r.cat?.slug ? { slug: r.cat.slug, name: r.cat.name } : null,
      // `clips.*` owns linking a clip to its playable video (d3-watch); the shelf links to the clip page.
      vodId: null,
      vodOffsetSeconds: null,
      channel: cardChannel(deps, r.channel, r.ownerImage),
    };
  });
  const last = page[page.length - 1];
  const more = rows.length > input.limit;
  return {
    items,
    nextCursor:
      more && last
        ? top
          ? encodeCursor({ o: offset + input.limit })
          : encodeCursor({ t: iso(last.c.createdAt), id: last.c.id })
        : null,
  };
}
