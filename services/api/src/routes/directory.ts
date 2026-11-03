// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `directory.*` (fair discovery, see ../discovery/README.md) and `categories.*`. */
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, not, or, sql, type SQL } from "drizzle-orm";
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
import { decodeCursor, encodeCursor, isOffsetCursor } from "../lib/cursor.ts";
import { notFound } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { discoveryRanking } from "../lib/settings.ts";
import { catchingUpCounts, viewerCounts } from "../lib/viewers.ts";
import { confirmedAdult } from "./me.ts";

const { channels, broadcasts, categories, users, follows } = schema;
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
 */
async function loadOffline(
  deps: Deps,
  opts: { allowMature: boolean; language?: string | undefined; followerId?: string },
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
    .where(and(isNotNull(broadcasts.endedAt), eq(broadcasts.kind, "live")))
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
    .limit(HOME_SECTION);
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
  }));
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
      loadOffline(deps, { allowMature, language: input.language }),
      caller
        ? loadOffline(deps, { allowMature, language: input.language, followerId: caller.user.id })
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
    const rows = await deps.db
      .select({ c: channels, ownerImage: users.image, rank: sql<number>`ts_rank(${doc}, ${query})` })
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
      .orderBy(desc(sql`ts_rank(${doc}, ${query})`), desc(channels.followerCount))
      .limit(input.limit);
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
      categories: catRows.map((r) => toCategory(deps, r.c, Number(r.n))),
    };
  }),

  ranking: os.directory.ranking.handler(async ({ context: { deps } }) => {
    const { config, version } = await discoveryRanking(deps.db);
    return { version, config, explanation: RANKING_EXPLANATION };
  }),
};

export function toCategory(deps: Deps, c: typeof categories.$inferSelect, liveChannels: number) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    boxArtUrl: mediaUrl(deps, c.boxArtKey),
    mature: c.mature,
    liveChannels,
  };
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
    .where(
      and(inLiveDirectory(), eq(broadcasts.mature, false), eq(channels.mature, false), eq(categories.mature, false)),
    )
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

/** One category's live count, as `categories.get` reports it. */
export async function liveChannelCount(deps: Deps, categoryId: string): Promise<number> {
  const [row] = await categoriesWithCounts(deps).query.where(eq(categories.id, categoryId)).limit(1);
  return Number(row?.n ?? 0);
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
      items: rows.slice(0, input.limit).map((r) => toCategory(deps, r.c, Number(r.n))),
      nextCursor: rows.length > input.limit ? encodeCursor({ o: offset + input.limit }) : null,
    };
  }),
  get: os.categories.get.handler(async ({ context: { deps }, input }) => {
    const [row] = await categoriesWithCounts(deps).query.where(eq(categories.slug, input.slug)).limit(1);
    if (!row) throw notFound("Category not found");
    return toCategory(deps, row.c, Number(row.n));
  }),
};
