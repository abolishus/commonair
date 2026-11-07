// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `directory.*` (fair discovery, see ../discovery/README.md) and `categories.*`. */
import {
  and,
  arrayOverlaps,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { vodPrefix } from "@commonair/contracts/storage";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import {
  matureFilter,
  newAndLive,
  pickRandom,
  rankLive,
  RANKING_EXPLANATION,
  spotlight,
  type LiveEntry,
} from "../discovery/ranking.ts";
import {
  channelAvatar,
  channelTheme,
  liveSummaries,
  mediaUrl,
  toBroadcastSummary,
  type ChannelCard,
  type StreamCard,
} from "../lib/dto.ts";
import { searchTags, topTags } from "../discovery/tags.ts";
import { vodVisible } from "../media/visibility.ts";
import { decodeCursor, encodeCursor, isOffsetCursor } from "../lib/cursor.ts";
import { notFound } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { discoveryRanking } from "../lib/settings.ts";
import { catchingUpCounts, viewerCounts } from "../lib/viewers.ts";
import { confirmedAdult } from "./me.ts";

const { channels, broadcasts, categories, users, follows, vods } = schema;
const MAX_LIVE = 2000;
const HOME_SECTION = 24;

type Reason = StreamCard["reason"];

interface LiveRow {
  entry: LiveEntry;
  card: (reason: Reason) => StreamCard;
  language: string;
  tags: string[];
  categorySlug: string | null;
}

/**
 * Who is in the live directory, over `channels ⋈ broadcasts (live) ⋈ users (owner)`. The category
 * counts use the same predicate, so they cannot drift from `directory.live`.
 */
const inLiveDirectory = () =>
  and(
    isNotNull(channels.liveBroadcastId),
    isNull(channels.suspendedAt),
    isNull(broadcasts.endedAt),
    // A T1-restricted broadcast is in no list, search or front-page section until cleared.
    isNull(broadcasts.restrictedAt),
    eq(users.banned, false),
  );

/** Every live, unsuspended, unrestricted channel with what ranking and cards need. */
async function loadLive(deps: Deps, filter?: { categorySlug?: string | undefined }): Promise<LiveRow[]> {
  const rows = await deps.db
    .select({ c: channels, b: broadcasts, cat: categories, ownerImage: users.image })
    .from(channels)
    .innerJoin(broadcasts, eq(broadcasts.id, channels.liveBroadcastId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .where(and(inLiveDirectory(), filter?.categorySlug ? eq(categories.slug, filter.categorySlug) : undefined))
    .limit(MAX_LIVE);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.c.id);
  const since = new Date(deps.now().getTime() - 86_400_000);
  const [counts, catchingUp, momentum] = await Promise.all([
    viewerCounts(deps, ids),
    catchingUpCounts(deps, ids),
    deps.db
      .select({ channelId: follows.channelId, n: sql<number>`count(*)::int` })
      .from(follows)
      .where(and(inArray(follows.channelId, ids), gt(follows.createdAt, since), isNull(follows.excludedAt)))
      .groupBy(follows.channelId),
  ]);
  const followsBy = new Map(momentum.map((m) => [m.channelId, Number(m.n)]));
  return rows.map(({ c, b, cat, ownerImage }) => {
    const viewers = counts.get(c.id) ?? 0;
    const mature = b.mature || c.mature || (cat?.mature ?? false);
    const summary = toBroadcastSummary(deps, { ...b, mature }, cat, viewers, catchingUp.get(c.id) ?? 0);
    return {
      entry: {
        channelId: c.id,
        channelCreatedAt: c.createdAt,
        broadcastStartedAt: b.startedAt,
        viewers,
        follows24h: followsBy.get(c.id) ?? 0,
        mature,
      },
      language: c.language,
      tags: c.tags,
      categorySlug: cat?.slug ?? null,
      card: (reason) => ({
        channel: {
          id: c.id,
          slug: c.slug,
          displayName: c.displayName,
          avatarUrl: channelAvatar(deps, c, ownerImage),
          accent: channelTheme(c).accent,
        },
        broadcast: summary,
        tags: c.tags,
        language: c.language,
        reason,
      }),
    };
  });
}

function cardsFor(rows: LiveRow[], ordered: LiveEntry[], reason: Reason, limit = Infinity): StreamCard[] {
  const byId = new Map(rows.map((r) => [r.entry.channelId, r]));
  return ordered
    .slice(0, limit)
    .map((e) => byId.get(e.channelId)?.card(reason))
    .filter((c): c is StreamCard => c !== undefined);
}

/**
 * Offline, unsuspended channels with their last ended broadcast, most recently live first.
 * `followerId` restricts to that user's follows and keeps channels that never broadcast.
 * `categoryId` takes each channel's last broadcast in that category instead (F9), so a category
 * page lists who streamed there lately even if they have since streamed something else.
 */
async function loadOffline(
  deps: Deps,
  opts: {
    allowMature: boolean;
    adult: boolean;
    language?: string | undefined;
    followerId?: string;
    categoryId?: string;
    limit?: number;
  },
): Promise<ChannelCard[]> {
  const last = deps.db
    .selectDistinctOn([broadcasts.channelId], {
      channelId: broadcasts.channelId,
      endedAt: broadcasts.endedAt,
      title: broadcasts.title,
      categoryId: broadcasts.categoryId,
      mature: broadcasts.mature,
    })
    .from(broadcasts)
    // A rehearsal is private (decision (f)): it never makes a channel look recently live.
    .where(
      and(
        isNotNull(broadcasts.endedAt),
        eq(broadcasts.kind, "live"),
        // A T1-restricted broadcast is in no list; it never stands for its category either.
        opts.categoryId ? and(eq(broadcasts.categoryId, opts.categoryId), isNull(broadcasts.restrictedAt)) : undefined,
      ),
    )
    .orderBy(broadcasts.channelId, desc(broadcasts.endedAt))
    .as("last");
  const followed = opts.followerId !== undefined;
  const mature = sql<boolean>`(${channels.mature} or coalesce(${last.mature}, false) or coalesce(${categories.mature}, false))`;
  const conditions: (SQL | undefined)[] = [
    isNull(channels.liveBroadcastId),
    isNull(channels.suspendedAt),
    eq(users.banned, false),
    followed ? undefined : isNotNull(last.channelId),
    opts.allowMature ? undefined : not(mature),
    opts.language ? eq(channels.language, opts.language) : undefined,
  ];
  let query = deps.db
    .select({
      c: channels,
      ownerImage: users.image,
      endedAt: last.endedAt,
      lastTitle: last.title,
      cat: { id: categories.id, slug: categories.slug, name: categories.name },
      mature,
    })
    .from(channels)
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(last, eq(last.channelId, channels.id))
    // The last broadcast's category, else the channel's.
    .leftJoin(categories, eq(categories.id, sql`coalesce(${last.categoryId}, ${channels.categoryId})`))
    .$dynamic();
  if (opts.followerId !== undefined) {
    query = query.innerJoin(follows, and(eq(follows.channelId, channels.id), eq(follows.followerId, opts.followerId)));
  }
  const rows = await query
    .where(and(...conditions))
    .orderBy(sql`${last.endedAt} desc nulls last`, channels.slug)
    .limit(opts.limit ?? HOME_SECTION);
  const latest = await latestVods(
    deps,
    rows.map((r) => r.c.id),
  );
  return rows.map(({ c, ownerImage, endedAt, lastTitle, cat, mature: isMature }) => ({
    channel: {
      id: c.id,
      slug: c.slug,
      displayName: c.displayName,
      avatarUrl: channelAvatar(deps, c, ownerImage),
      accent: channelTheme(c).accent,
    },
    title: lastTitle || c.title,
    category: cat?.id ? cat : null,
    lastLiveAt: endedAt ? endedAt.toISOString() : null,
    followerCount: c.followerCount,
    mature: isMature,
    latestVod: latestVodRef(deps, latest.get(c.id), isMature, opts.adult),
  }));
}

interface LatestVodRow {
  id: string;
  storagePrefix: string;
  thumbnailKey: string | null;
  durationSeconds: number;
  /** The VOD's broadcast, its channel or either one's category is mature (as `urlsWithheld`). */
  mature: boolean;
}

const vodChannelCategory = alias(categories, "vod_channel_category");

/**
 * Each channel's newest VOD anyone may watch (ready, public, nothing removed or restricted: the
 * public audience of `vodVisible`), in one DISTINCT ON query for every card.
 */
async function latestVods(deps: Deps, channelIds: readonly string[]): Promise<Map<string, LatestVodRow>> {
  if (channelIds.length === 0) return new Map();
  const rows = await deps.db
    .selectDistinctOn([vods.channelId], {
      channelId: vods.channelId,
      id: vods.id,
      storagePrefix: vods.storagePrefix,
      thumbnailKey: vods.thumbnailKey,
      durationSeconds: vods.durationSeconds,
      mature: sql<boolean>`(${broadcasts.mature} or ${channels.mature} or coalesce(${categories.mature}, false) or coalesce(${vodChannelCategory.mature}, false))`,
    })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .leftJoin(vodChannelCategory, eq(vodChannelCategory.id, channels.categoryId))
    .where(and(inArray(vods.channelId, [...channelIds]), vodVisible("public")))
    .orderBy(vods.channelId, desc(vods.createdAt), desc(vods.id));
  return new Map(rows.map(({ channelId, ...v }) => [channelId, v]));
}

/**
 * The card's VOD. The thumbnail is the public `/media` URL `vods.get` gives a public VOD whose
 * objects already moved to the public prefix; one still moving has none here (a card does not
 * mint playback tokens). A mature thumbnail goes only to confirmed adults, as in `vods.*`.
 */
function latestVodRef(deps: Deps, v: LatestVodRow | undefined, cardMature: boolean, adult: boolean) {
  if (!v) return null;
  const withheld = !adult && (cardMature || v.mature);
  const placed = v.storagePrefix === vodPrefix(v.id, "public");
  return {
    id: v.id,
    thumbnailUrl: withheld || !placed ? null : mediaUrl(deps, v.thumbnailKey),
    durationSeconds: v.durationSeconds,
  };
}

const lowerTag = (tags: string[], tag: string) => tags.some((t) => t.toLowerCase() === tag.toLowerCase());
export const directory = {
  home: os.directory.home.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    const [{ config, version }, adult] = await Promise.all([
      discoveryRanking(deps.db),
      confirmedAdult(deps, caller?.user.id),
    ]);
    const now = deps.now();
    const allowed = matureFilter(input.includeMature, adult);
    const rows = (await loadLive(deps)).filter(
      (r) => allowed(r.entry) && (!input.language || r.language === input.language),
    );
    const allowMature = input.includeMature && adult;
    const [recentlyLive, followingOffline] = await Promise.all([
      loadOffline(deps, { allowMature, adult, language: input.language }),
      caller
        ? loadOffline(deps, { allowMature, adult, language: input.language, followerId: caller.user.id })
        : Promise.resolve([]),
    ]);
    const entries = rows.map((r) => r.entry);
    const ranked = rankLive(entries, config, now);
    let following: StreamCard[] = [];
    if (caller && entries.length > 0) {
      const followed = await deps.db
        .select({ channelId: follows.channelId })
        .from(follows)
        .where(
          and(
            eq(follows.followerId, caller.user.id),
            inArray(
              follows.channelId,
              entries.map((e) => e.channelId),
            ),
          ),
        );
      const set = new Set(followed.map((f) => f.channelId));
      following = cardsFor(
        rows,
        ranked.filter((e) => set.has(e.channelId)),
        "following",
        HOME_SECTION,
      );
    }
    return {
      spotlight: cardsFor(rows, spotlight(entries, config, now), "spotlight"),
      newAndLive: cardsFor(rows, newAndLive(entries, config, now), "new", HOME_SECTION),
      live: cardsFor(rows, ranked, "popular", HOME_SECTION),
      following,
      recentlyLive,
      followingOffline,
      rankingVersion: version,
    };
  }),

  live: os.directory.live.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    const [{ config }, adult] = await Promise.all([discoveryRanking(deps.db), confirmedAdult(deps, caller?.user.id)]);
    const allowed = matureFilter(input.includeMature, adult);
    const rows = (await loadLive(deps, { categorySlug: input.category })).filter(
      (r) =>
        allowed(r.entry) &&
        (!input.language || r.language === input.language) &&
        (!input.tag || lowerTag(r.tags, input.tag)),
    );
    const entries = rows.map((r) => r.entry);
    const tie = (a: LiveEntry, b: LiveEntry) => a.channelId.localeCompare(b.channelId);
    const ordered =
      input.sort === "recommended"
        ? rankLive(entries, config, deps.now())
        : input.sort === "viewers_desc"
          ? [...entries].sort((a, b) => b.viewers - a.viewers || tie(a, b))
          : input.sort === "viewers_asc"
            ? [...entries].sort((a, b) => a.viewers - b.viewers || tie(a, b))
            : [...entries].sort((a, b) => b.broadcastStartedAt.getTime() - a.broadcastStartedAt.getTime() || tie(a, b));
    const offset = decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0;
    const pageEntries = ordered.slice(offset, offset + input.limit);
    return {
      items: cardsFor(rows, pageEntries, input.category ? "category" : "popular"),
      nextCursor: offset + input.limit < ordered.length ? encodeCursor({ o: offset + input.limit }) : null,
    };
  }),

  random: os.directory.random.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    const adult = await confirmedAdult(deps, caller?.user.id);
    const allowed = matureFilter(input.includeMature, adult);
    const rows = (await loadLive(deps, { categorySlug: input.category })).filter((r) => allowed(r.entry));
    return pickRandom(rows)?.card("random") ?? null;
  }),

  search: os.directory.search.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    const q = input.q.trim();
    const adult = await confirmedAdult(deps, caller?.user.id);
    // Must match the channels_search_idx expression exactly for the GIN index to be used.
    const doc = sql`to_tsvector('simple', ${channels.displayName} || ' ' || ${channels.title} || ' ' || ${channels.description})`;
    const query = sql`plainto_tsquery('simple', ${q})`;
    const like = `${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    // F9: live streams also match on their stream title and tags, and come first. Searched on the
    // live set only (at most MAX_LIVE rows), so the channel query below keeps its GIN index.
    const streamDoc = sql`to_tsvector('simple', ${broadcasts.title})`;
    const words = searchTags(q);
    const liveRank = sql<number>`(ts_rank(${doc}, ${query}) + ts_rank(${streamDoc}, ${query}))`;
    const liveRows = await deps.db
      .select({ c: channels, ownerImage: users.image })
      .from(channels)
      .innerJoin(broadcasts, eq(broadcasts.id, channels.liveBroadcastId))
      .innerJoin(users, eq(users.id, channels.ownerId))
      .where(
        and(
          inLiveDirectory(),
          adult ? undefined : and(eq(channels.mature, false), eq(broadcasts.mature, false)),
          or(
            sql`${doc} @@ ${query}`,
            sql`${streamDoc} @@ ${query}`,
            ilike(channels.slug, like),
            words.length > 0 ? arrayOverlaps(channels.tags, words) : undefined,
          ),
        ),
      )
      .orderBy(desc(liveRank), desc(channels.followerCount), channels.slug)
      .limit(input.limit);
    // A viewer account (no followers, never broadcast) sinks below every channel that streams.
    const viewerAccount = sql<boolean>`(${channels.followerCount} = 0 and not exists (select 1 from broadcasts vb where vb.channel_id = ${channels.id} and vb.kind = 'live'))`;
    const channelRows = await deps.db
      .select({ c: channels, ownerImage: users.image })
      .from(channels)
      .innerJoin(users, eq(users.id, channels.ownerId))
      .where(
        and(
          isNull(channels.suspendedAt),
          eq(users.banned, false),
          or(sql`${doc} @@ ${query}`, ilike(channels.slug, like)),
          sql`not exists (select 1 from ${broadcasts} where ${broadcasts.id} = ${channels.liveBroadcastId} and ${broadcasts.restrictedAt} is not null)`,
          adult ? undefined : eq(channels.mature, false),
        ),
      )
      .orderBy(viewerAccount, desc(sql`ts_rank(${doc}, ${query})`), desc(channels.followerCount), channels.slug)
      .limit(input.limit);
    const seen = new Set(liveRows.map((r) => r.c.id));
    const rows = [...liveRows, ...channelRows.filter((r) => !seen.has(r.c.id))].slice(0, input.limit);
    const live = await liveSummaries(
      deps,
      rows.map((r) => r.c),
    );
    const catRows = await categoriesWithCounts(deps)
      .query.where(ilike(categories.name, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`))
      .limit(input.limit);
    return {
      channels: rows
        .map((r) => ({ r, l: live.get(r.c.id) ?? null }))
        .filter(({ l }) => adult || !l?.mature)
        .map(({ r, l }) => ({
          slug: r.c.slug,
          displayName: r.c.displayName,
          avatarUrl: channelAvatar(deps, r.c, r.ownerImage),
          live: l,
          followerCount: r.c.followerCount,
        })),
      categories: await categoryDtos(deps, catRows),
    };
  }),

  ranking: os.directory.ranking.handler(async ({ context: { deps } }) => {
    const { config, version } = await discoveryRanking(deps.db);
    return { version, config, explanation: RANKING_EXPLANATION };
  }),
};

type CategoryRow = typeof categories.$inferSelect;
interface CategoryStats {
  viewerCount: number;
  tags: string[];
}

export function toCategory(deps: Deps, c: CategoryRow, liveChannels: number, stats: CategoryStats) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    boxArtUrl: mediaUrl(deps, c.boxArtKey),
    mature: c.mature,
    liveChannels,
    viewerCount: stats.viewerCount,
    tags: stats.tags,
  };
}

/**
 * A live stream counts toward its broadcast's category (not the channel's) when the default
 * `directory.live?category=<slug>` lists it: the directory's visibility predicate, and
 * mature-exclusive. Over `channels ⋈ broadcasts (live) ⋈ users (owner) ⋈ categories`.
 */
const listedInCategory = () =>
  and(inLiveDirectory(), eq(broadcasts.mature, false), eq(channels.mature, false), eq(categories.mature, false));

/**
 * Viewers and tags of these categories' listed live streams: one query for the streams and one
 * viewer-count read for all of them (Valkey, then Postgres for misses), however many categories.
 */
async function categoryStats(deps: Deps, categoryIds: readonly string[]): Promise<Map<string, CategoryStats>> {
  const out = new Map<string, CategoryStats>();
  const ids = [...new Set(categoryIds)];
  if (ids.length === 0) return out;
  const streams = await deps.db
    .select({ channelId: channels.id, categoryId: categories.id, tags: channels.tags })
    .from(channels)
    .innerJoin(broadcasts, eq(broadcasts.id, channels.liveBroadcastId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .innerJoin(categories, eq(categories.id, broadcasts.categoryId))
    .where(and(listedInCategory(), inArray(categories.id, ids)))
    .limit(MAX_LIVE);
  const counts = await viewerCounts(
    deps,
    streams.map((r) => r.channelId),
  );
  const byCategory = new Map<string, { viewers: number; tags: string[][] }>();
  for (const r of streams) {
    const agg = byCategory.get(r.categoryId) ?? { viewers: 0, tags: [] };
    agg.viewers += counts.get(r.channelId) ?? 0;
    agg.tags.push(r.tags);
    byCategory.set(r.categoryId, agg);
  }
  for (const id of ids) {
    const agg = byCategory.get(id);
    out.set(id, { viewerCount: agg?.viewers ?? 0, tags: agg ? topTags(agg.tags) : [] });
  }
  return out;
}

/** Category rows with their live counts as DTOs, stats loaded for all of them at once. */
async function categoryDtos(deps: Deps, rows: readonly { c: CategoryRow; n: number }[]) {
  const stats = await categoryStats(
    deps,
    rows.map((r) => r.c.id),
  );
  return rows.map((r) => toCategory(deps, r.c, Number(r.n), stats.get(r.c.id) ?? { viewerCount: 0, tags: [] }));
}

/**
 * Live channels per category, counted the way `directory.live?category=<slug>` lists them with
 * its default `includeMature=false`: by the live broadcast's category (not the channel's), under
 * the directory's own visibility predicate, and mature-exclusive (a mature broadcast, channel or
 * category never counts). The categories contract takes no mature setting, so the count is the
 * same for every caller and equals that default listing for anyone; an adult who opts in to
 * mature streams may see more. One grouped subquery per call and no cache, so it is as fresh as
 * the directory.
 */
function liveCounts(deps: Deps) {
  return deps.db
    .select({ categoryId: broadcasts.categoryId, n: sql<number>`count(*)::int`.as("n") })
    .from(channels)
    .innerJoin(broadcasts, eq(broadcasts.id, channels.liveBroadcastId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .innerJoin(categories, eq(categories.id, broadcasts.categoryId))
    .where(listedInCategory())
    .groupBy(broadcasts.categoryId)
    .as("live_counts");
}

/**
 * Categories joined to their live counts. A join, not a scalar subquery in the select list:
 * drizzle drops table names from a single-table select's columns, which turned the old
 * `channels.category_id = categories.id` into `"categoryId" = "id"` on channels alone, always
 * false, so every category read 0 (F20).
 */
function categoriesWithCounts(deps: Deps) {
  const counts = liveCounts(deps);
  const n = sql<number>`coalesce(${counts.n}, 0)`;
  return {
    n,
    query: deps.db
      .select({ c: categories, n })
      .from(categories)
      .leftJoin(counts, eq(counts.categoryId, categories.id))
      .$dynamic(),
  };
}

/** One category as `categories.get` reports it (admin upserts return the same). */
export async function categoryDto(deps: Deps, c: CategoryRow) {
  const [row] = await categoriesWithCounts(deps).query.where(eq(categories.id, c.id)).limit(1);
  const [dto] = await categoryDtos(deps, [{ c: row?.c ?? c, n: Number(row?.n ?? 0) }]);
  if (!dto) throw new Error("categoryDtos returned no row");
  return dto;
}

export const categoriesRoutes = {
  /** Busiest first. `liveChannels` is mature-exclusive, as `directory.live` is by default. */
  list: os.categories.list.handler(async ({ context: { deps }, input }) => {
    const offset = decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0;
    const q = input.q?.trim();
    const { n, query } = categoriesWithCounts(deps);
    const rows = await query
      .where(q ? ilike(categories.name, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) : undefined)
      .orderBy(desc(n), categories.name)
      .limit(input.limit + 1)
      .offset(offset);
    return {
      items: await categoryDtos(deps, rows.slice(0, input.limit)),
      nextCursor: rows.length > input.limit ? encodeCursor({ o: offset + input.limit }) : null,
    };
  }),
  recentlyLive: os.categories.recentlyLive.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    const [[category], adult] = await Promise.all([
      deps.db.select().from(categories).where(eq(categories.slug, input.slug)).limit(1),
      confirmedAdult(deps, caller?.user.id),
    ]);
    if (!category) throw notFound("Category not found");
    const allowMature = input.includeMature && adult;
    // A mature category has nothing for anyone who has not opted in, as in `directory.live`.
    if (category.mature && !allowMature) return [];
    return loadOffline(deps, {
      allowMature,
      adult,
      language: input.language,
      categoryId: category.id,
      limit: input.limit,
    });
  }),
  get: os.categories.get.handler(async ({ context: { deps }, input }) => {
    const [row] = await categoriesWithCounts(deps).query.where(eq(categories.slug, input.slug)).limit(1);
    if (!row) throw notFound("Category not found");
    const [dto] = await categoryDtos(deps, [row]);
    if (!dto) throw notFound("Category not found");
    return dto;
  }),
};
