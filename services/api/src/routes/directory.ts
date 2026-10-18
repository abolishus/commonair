// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `directory.*` (fair discovery, see ../discovery/README.md) and `categories.*`. */
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
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
  type StreamCard,
} from "../lib/dto.ts";
import { decodeCursor, encodeCursor, isOffsetCursor } from "../lib/cursor.ts";
import { notFound } from "../lib/errors.ts";
import { os } from "../lib/orpc.ts";
import { discoveryRanking } from "../lib/settings.ts";
import { viewerCounts } from "../lib/viewers.ts";
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

/** Every live, unsuspended channel with what ranking and cards need. */
async function loadLive(deps: Deps, filter?: { categorySlug?: string | undefined }): Promise<LiveRow[]> {
  const rows = await deps.db
    .select({ c: channels, b: broadcasts, cat: categories, ownerImage: users.image })
    .from(channels)
    .innerJoin(broadcasts, eq(broadcasts.id, channels.liveBroadcastId))
    .innerJoin(users, eq(users.id, channels.ownerId))
    .leftJoin(categories, eq(categories.id, broadcasts.categoryId))
    .where(
      and(
        isNotNull(channels.liveBroadcastId),
        isNull(channels.suspendedAt),
        isNull(broadcasts.endedAt),
        eq(users.banned, false),
        filter?.categorySlug ? eq(categories.slug, filter.categorySlug) : undefined,
      ),
    )
    .limit(MAX_LIVE);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.c.id);
  const since = new Date(deps.now().getTime() - 86_400_000);
  const [counts, momentum] = await Promise.all([
    viewerCounts(deps, ids),
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
    const summary = toBroadcastSummary(deps, { ...b, mature }, cat, viewers);
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
          adult ? undefined : eq(channels.mature, false),
        ),
      )
      .orderBy(desc(sql`ts_rank(${doc}, ${query})`), desc(channels.followerCount))
      .limit(input.limit);
    const live = await liveSummaries(
      deps,
      rows.map((r) => r.c),
    );
    const catRows = await deps.db
      .select()
      .from(categories)
      .where(ilike(categories.name, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`))
      .limit(input.limit);
    const catCounts = await liveCountsByCategory(
      deps,
      catRows.map((c) => c.id),
    );
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
      categories: catRows.map((c) => toCategory(deps, c, catCounts.get(c.id) ?? 0)),
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

async function liveCountsByCategory(deps: Deps, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await deps.db
    .select({ id: channels.categoryId, n: sql<number>`count(*)::int` })
    .from(channels)
    .where(and(inArray(channels.categoryId, ids), isNotNull(channels.liveBroadcastId), isNull(channels.suspendedAt)))
    .groupBy(channels.categoryId);
  return new Map(rows.filter((r) => r.id !== null).map((r) => [r.id as string, Number(r.n)]));
}

const liveCount = sql<number>`(select count(*)::int from ${channels} where ${channels.categoryId} = ${categories.id} and ${channels.liveBroadcastId} is not null and ${channels.suspendedAt} is null)`;

export const categoriesRoutes = {
  list: os.categories.list.handler(async ({ context: { deps }, input }) => {
    const offset = decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0;
    const q = input.q?.trim();
    const rows = await deps.db
      .select({ c: categories, n: liveCount })
      .from(categories)
      .where(q ? ilike(categories.name, `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`) : undefined)
      .orderBy(desc(liveCount), categories.name)
      .limit(input.limit + 1)
      .offset(offset);
    return {
      items: rows.slice(0, input.limit).map((r) => toCategory(deps, r.c, Number(r.n))),
      nextCursor: rows.length > input.limit ? encodeCursor({ o: offset + input.limit }) : null,
    };
  }),
  get: os.categories.get.handler(async ({ context: { deps }, input }) => {
    const [row] = await deps.db
      .select({ c: categories, n: liveCount })
      .from(categories)
      .where(eq(categories.slug, input.slug))
      .limit(1);
    if (!row) throw notFound("Category not found");
    return toCategory(deps, row.c, Number(row.n));
  }),
};
