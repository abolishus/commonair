// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Search v2 (overhaul D3.4): the videos and clips whose title matches, as cards across channels.
 *
 * Who sees what follows `media/visibility.ts` for the public (ready, public, nothing removed or
 * restricted, the channel not suspended and its owner not banned) and the channel results' mature
 * rule: anyone who has not confirmed 18+ gets no mature-labelled item at all (the broadcast, the
 * channel or either category), so nothing listed here ever needs its URLs withheld. Even an owner
 * or a subscriber sees only public items in search.
 *
 * A card mints no playback token (as `latestVodRef` in routes/directory.ts): a video whose objects
 * have not reached the public prefix yet has no thumbnail or playlist here, and cards carry no
 * caption tracks; the watch page loads both.
 */
import { and, desc, eq, isNull, sql, type Column, type SQL } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { VOD_PLAYLIST, vodPrefix } from "@commonair/contracts/storage";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { channelAvatar, channelTheme, iso, isoOrNull, loadUsersPublic, mediaUrl } from "../lib/dto.ts";
import { channelCategory, clipVisible, vodVisible } from "../media/visibility.ts";

const { broadcasts, categories, channels, clips, users, vods } = schema;
type ChannelRow = typeof channels.$inferSelect;
type VodCard = z.infer<typeof dto.VodCard>;
type ClipCard = z.infer<typeof dto.ClipCard>;

/**
 * Every word of the query in any order, as full-text search alone. No ILIKE substring branch: an
 * OR with a predicate no index serves forces a full scan of vods and clips on every keystroke of
 * this public search. `to_tsvector('simple', title)` must stay byte-identical to the expression of
 * the `vods_title_search_idx` and `clips_title_search_idx` GIN indexes for them to be used.
 */
const titleMatches = (title: Column, q: string): SQL =>
  sql`to_tsvector('simple', ${title}) @@ plainto_tsquery('simple', ${q})`;

/**
 * No mature label anywhere, over a query joining `broadcasts` (possibly left: a clip's broadcast
 * may be gone), `channels`, the broadcast's `categories` and `channelCategory` (both left).
 */
const notMature = (): SQL =>
  and(
    sql`coalesce(${broadcasts.mature}, false) = false`,
    eq(channels.mature, false),
    sql`coalesce(${categories.mature}, false) = false`,
    sql`coalesce(${channelCategory.mature}, false) = false`,
  ) as SQL;

/** Listed channels only: not suspended, owner not banned. */
const channelListed = (): SQL => and(isNull(channels.suspendedAt), eq(users.banned, false)) as SQL;

const cardChannel = (deps: Deps, c: ChannelRow, ownerImage: string | null): VodCard["channel"] => ({
  id: c.id,
  slug: c.slug,
  displayName: c.displayName,
  avatarUrl: channelAvatar(deps, c, ownerImage),
  accent: channelTheme(c).accent,
});

const categoryCols = { slug: categories.slug, name: categories.name };
const categoryOf = (cat: { slug: string | null; name: string | null } | null) =>
  cat?.slug && cat.name ? { slug: cat.slug, name: cat.name } : null;

/** Public, ready videos whose title matches `q`, newest first. */
export async function searchVideos(deps: Deps, opts: { q: string; adult: boolean; limit: number }): Promise<VodCard[]> {
  const rows = await deps.db
    .select({ v: vods, channel: channels, ownerImage: users.image, cat: categoryCols })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .leftJoin(channelCategory, eq(channelCategory.id, channels.categoryId))
    .where(
      and(
        vodVisible("public"),
        channelListed(),
        opts.adult ? undefined : notMature(),
        titleMatches(vods.title, opts.q),
      ),
    )
    .orderBy(desc(vods.createdAt), desc(vods.id))
    .limit(opts.limit);
  return rows.map(({ v, channel, ownerImage, cat }) => {
    const placed = v.storagePrefix === vodPrefix(v.id, "public");
    return {
      id: v.id,
      channelSlug: channel.slug,
      title: v.title,
      status: v.status,
      visibility: v.visibility,
      durationSeconds: v.durationSeconds,
      thumbnailUrl: placed ? mediaUrl(deps, v.thumbnailKey) : null,
      playlistUrl: placed ? mediaUrl(deps, `${v.storagePrefix}${VOD_PLAYLIST}`) : null,
      createdAt: iso(v.createdAt),
      expiresAt: isoOrNull(v.expiresAt),
      failedReason: null,
      category: categoryOf(cat),
      captions: [],
      channel: cardChannel(deps, channel, ownerImage),
    };
  });
}

/** Ready clips (no more visible than their source) whose title matches `q`, most viewed first. */
export async function searchClips(deps: Deps, opts: { q: string; adult: boolean; limit: number }): Promise<ClipCard[]> {
  const rows = await deps.db
    .select({
      c: clips,
      channel: channels,
      ownerImage: users.image,
      startedAt: broadcasts.startedAt,
      cat: categoryCols,
    })
    .from(clips)
    .leftJoin(broadcasts, eq(broadcasts.id, clips.broadcastId))
    .innerJoin(channels, eq(channels.id, clips.channelId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .leftJoin(channelCategory, eq(channelCategory.id, channels.categoryId))
    .where(
      and(
        clipVisible("public"),
        channelListed(),
        opts.adult ? undefined : notMature(),
        titleMatches(clips.title, opts.q),
      ),
    )
    .orderBy(desc(clips.views), desc(clips.createdAt), desc(clips.id))
    .limit(opts.limit);
  const creators = await loadUsersPublic(
    deps,
    rows.map((r) => r.c.creatorId).filter((id): id is string => id !== null),
  );
  return rows.map(({ c, channel, ownerImage, startedAt, cat }) => {
    const u = c.creatorId ? creators.get(c.creatorId) : undefined;
    return {
      id: c.id,
      channelSlug: channel.slug,
      title: c.title,
      creator: u ? { id: u.id, username: u.username, displayName: u.displayName } : null,
      status: c.status,
      durationSeconds: c.durationSeconds,
      url: mediaUrl(deps, c.storageKey),
      thumbnailUrl: mediaUrl(deps, c.thumbnailKey),
      views: c.views,
      createdAt: iso(c.createdAt),
      // As `clips.chat` places the window (chat-replay/handlers.ts).
      windowStartedAt: startedAt ? new Date(startedAt.getTime() + c.startOffset * 1000).toISOString() : null,
      category: categoryOf(cat),
      // As in `clips.*` until d3-watch links a clip to its broadcast's playable video.
      vodId: null,
      vodOffsetSeconds: null,
      channel: cardChannel(deps, channel, ownerImage),
    };
  });
}
