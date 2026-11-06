// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `directory.*` and `categories.*` edges: every `directory.live` sort with its channel-id tie
 * break, offset paging, tag/language/category filters, the mature gate (asked for and confirmed),
 * `random` (none, filtered), the home page's following section and language filter, search
 * (slug prefix, LIKE escaping, mature and restricted channels, categories), the ranking config,
 * and category paging, search and 404.
 *
 * This file owns its database, so every live channel here is one this file made.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Card = {
  channel: { id: string; slug: string };
  broadcast: { viewerCount: number; mature: boolean; category: { slug: string } | null };
  reason: string;
  tags: string[];
  language: string;
};
type Page = { items: Card[]; nextCursor: string | null };

let api: TestApi;
let viewer: User;
let adult: User;
/** Live channels by role in the fixtures. */
const S: Record<"big" | "mid" | "small" | "mature" | "restricted" | "french", User> = {} as never;
const starts: Record<string, Date> = {};
let catSlug = "";
let otherCatSlug = "";

const db = () => api.db.db;

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function live(
  u: User,
  opts: {
    viewers: number;
    minutesAgo: number;
    categoryId?: string | null;
    tags?: string[];
    language?: string;
    mature?: boolean;
    restricted?: boolean;
  },
) {
  const c = await channelOf(u.username);
  await db()
    .update(schema.channels)
    .set({ tags: opts.tags ?? [], language: opts.language ?? "en", title: `${u.username} live` })
    .where(eq(schema.channels.id, c.id));
  const startedAt = new Date(Date.now() - opts.minutesAgo * 60_000);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId: c.id,
      ingestProtocol: "rtmp",
      path: mediaPath(u.username),
      title: "live",
      categoryId: opts.categoryId ?? null,
      mature: opts.mature ?? false,
      startedAt,
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, c.id));
  await api.deps.valkey.set(KEYS.viewerCount(c.id), String(opts.viewers), "EX", 3600);
  starts[u.username] = startedAt;
}

beforeAll(async () => {
  api = await startApi();
  const list = await Promise.all(Array.from({ length: 8 }, () => signUpAndSignIn(api)));
  const [big, mid, small, mature, restricted, french, v, a] = list;
  if (!big || !mid || !small || !mature || !restricted || !french || !v || !a) throw new Error("signup");
  Object.assign(S, { big, mid, small, mature, restricted, french });
  viewer = v;
  adult = a;
  if ((await adult.client.call("POST", "/api/me/mature-confirmation")).status !== 200) throw new Error("confirm");
  const suffix = uuidv7().slice(-8);
  const [cat, other] = await db()
    .insert(schema.categories)
    .values([
      { slug: `cov-dir-${suffix}`, name: `Cov Speedruns ${suffix}` },
      { slug: `cov-other-${suffix}`, name: `Cov Other ${suffix}` },
    ])
    .returning();
  if (!cat || !other) throw new Error("categories");
  catSlug = cat.slug;
  otherCatSlug = other.slug;
  await live(big, { viewers: 50, minutesAgo: 90, categoryId: cat.id, tags: ["speedrun", "any"] });
  await live(mid, { viewers: 10, minutesAgo: 10, categoryId: cat.id, tags: ["Casual"] });
  await live(small, { viewers: 10, minutesAgo: 30, tags: ["speedrun"] });
  await live(mature, { viewers: 5, minutesAgo: 20, mature: true, categoryId: cat.id });
  await live(restricted, { viewers: 999, minutesAgo: 5, restricted: true });
  await live(french, { viewers: 1, minutesAgo: 40, language: "fr" });
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const slugs = (p: Page) => p.items.map((c) => c.channel.slug);
const get = async (who: { call: User["client"]["call"] }, path: string) => {
  const r = await who.call<Page>("GET", path);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const idOf = async (u: User) => (await channelOf(u.username)).id;

describe("directory.live", () => {
  test("viewers_desc and viewers_asc break ties by channel id; restricted and mature are out", async () => {
    const tie = [S.mid, S.small];
    const ids = new Map(await Promise.all(tie.map(async (u) => [u.username, await idOf(u)] as const)));
    const [lo, hi] = [...ids].sort((x, y) => x[1].localeCompare(y[1])).map(([s]) => s);
    const desc = await get(client(api), "/api/directory/live?sort=viewers_desc&limit=100");
    expect(slugs(desc)).toEqual([S.big.username, lo, hi, S.french.username]);
    const asc = await get(client(api), "/api/directory/live?sort=viewers_asc&limit=100");
    expect(slugs(asc)).toEqual([S.french.username, lo, hi, S.big.username]);
    expect(desc.items.every((c) => c.reason === "popular")).toBe(true);
  });

  test("recent orders by start, newest first; recommended lists the same channels", async () => {
    const recent = await get(client(api), "/api/directory/live?sort=recent&limit=100");
    expect(slugs(recent)).toEqual([S.mid.username, S.small.username, S.french.username, S.big.username]);
    const rec = await get(client(api), "/api/directory/live?limit=100");
    expect(slugs(rec).sort()).toEqual(slugs(recent).sort());
  });

  test("offset pages cover the list exactly once and end with a null cursor", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const p: Page = await get(
        client(api),
        `/api/directory/live?sort=viewers_desc&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...slugs(p));
      cursor = p.nextCursor;
      pages++;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(4);
    expect(seen).toHaveLength(4);
  });

  test("tag (case-insensitive), language and category filters", async () => {
    expect(slugs(await get(client(api), "/api/directory/live?tag=SPEEDRUN&sort=recent")).sort()).toEqual(
      [S.big.username, S.small.username].sort(),
    );
    expect(slugs(await get(client(api), "/api/directory/live?tag=casual"))).toEqual([S.mid.username]);
    expect(slugs(await get(client(api), "/api/directory/live?language=fr"))).toEqual([S.french.username]);
    const inCat = await get(client(api), `/api/directory/live?category=${catSlug}&sort=recent`);
    expect(slugs(inCat)).toEqual([S.mid.username, S.big.username]);
    expect(inCat.items.every((c) => c.reason === "category" && c.broadcast.category?.slug === catSlug)).toBe(true);
    expect((await get(client(api), `/api/directory/live?category=${otherCatSlug}`)).items).toEqual([]);
  });

  test("mature streams only for a confirmed adult who asks for them", async () => {
    const path = "/api/directory/live?includeMature=true&limit=100";
    expect(slugs(await get(viewer.client, path))).not.toContain(S.mature.username);
    expect(slugs(await get(adult.client, "/api/directory/live?limit=100"))).not.toContain(S.mature.username);
    const shown = await get(adult.client, path);
    expect(slugs(shown)).toContain(S.mature.username);
    expect(shown.items.find((c) => c.channel.slug === S.mature.username)?.broadcast.mature).toBe(true);
    expect(slugs(shown)).not.toContain(S.restricted.username);
  });
});

describe("directory.random", () => {
  test("a listed live channel, or null when the filter leaves none", async () => {
    const r = await client(api).call<Card | null>("GET", "/api/directory/random");
    expect(r.status).toBe(200);
    expect(r.body?.reason).toBe("random");
    expect([S.big, S.mid, S.small, S.french].map((u) => u.username)).toContain(r.body?.channel.slug);
    const none = await client(api).call<Card | null>("GET", `/api/directory/random?category=${otherCatSlug}`);
    expect(none.status).toBe(200);
    expect(none.body).toBeNull();
    for (let i = 0; i < 5; i++) {
      const inCat = await client(api).call<Card | null>("GET", `/api/directory/random?category=${catSlug}`);
      expect([S.big.username, S.mid.username]).toContain(inCat.body?.channel.slug);
    }
  });
});

describe("directory.home", () => {
  type Home = {
    spotlight: Card[];
    newAndLive: Card[];
    live: Card[];
    following: Card[];
    recentlyLive: unknown[];
    followingOffline: unknown[];
    rankingVersion: string;
  };

  test("the following section is the caller's live follows; anonymous callers have none", async () => {
    const anon = await client(api).call<Home>("GET", "/api/directory");
    expect(anon.status).toBe(200);
    expect(anon.body.following).toEqual([]);
    expect(anon.body.followingOffline).toEqual([]);
    expect(typeof anon.body.rankingVersion).toBe("string");
    expect(anon.body.live.map((c) => c.channel.slug).sort()).toEqual(
      [S.big, S.mid, S.small, S.french].map((u) => u.username).sort(),
    );
    // Every channel here is days old at most: all are new.
    expect(anon.body.newAndLive).toHaveLength(4);

    const fan = await signUpAndSignIn(api);
    const before = await fan.client.call<Home>("GET", "/api/directory");
    expect(before.body.following).toEqual([]);
    await fan.client.call("PUT", `/api/channels/${S.small.username}/follow`, {});
    await fan.client.call("PUT", `/api/channels/${S.mature.username}/follow`, {});
    const after = await fan.client.call<Home>("GET", "/api/directory");
    // The mature follow stays out for a non-adult.
    expect(after.body.following.map((c) => [c.channel.slug, c.reason])).toEqual([[S.small.username, "following"]]);
  });

  test("language narrows the live sections", async () => {
    const r = await client(api).call<Home>("GET", "/api/directory?language=fr");
    expect(r.body.live.map((c) => c.channel.slug)).toEqual([S.french.username]);
    expect(r.body.spotlight.every((c) => c.language === "fr")).toBe(true);
  });

  test("a confirmed adult asking for mature streams sees them", async () => {
    const r = await adult.client.call<Home>("GET", "/api/directory?includeMature=true");
    expect(r.body.live.map((c) => c.channel.slug)).toContain(S.mature.username);
  });
});

describe("directory.search", () => {
  type Search = {
    channels: { slug: string; live: { mature: boolean } | null; followerCount: number }[];
    categories: { slug: string; liveChannels: number }[];
  };
  const search = async (who: { call: User["client"]["call"] }, q: string) => {
    const r = await who.call<Search>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=50`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  test("finds a channel by slug prefix with its live summary", async () => {
    const r = await search(client(api), S.big.username.slice(0, 8));
    const hit = r.channels.find((c) => c.slug === S.big.username);
    expect(hit?.live).not.toBeNull();
  });

  test("LIKE wildcards in the query match literally", async () => {
    expect((await search(client(api), "%")).channels).toEqual([]);
    expect((await search(client(api), "_")).channels).toEqual([]);
  });

  test("restricted live channels never appear; a mature live stream only for adults", async () => {
    expect((await search(client(api), S.restricted.username)).channels).toEqual([]);
    expect((await search(viewer.client, S.mature.username)).channels).toEqual([]);
    const adultHit = await search(adult.client, S.mature.username);
    expect(adultHit.channels.map((c) => c.slug)).toEqual([S.mature.username]);
    expect(adultHit.channels[0]?.live?.mature).toBe(true);
  });

  test("a mature-labelled channel is hidden from non-adults even offline", async () => {
    const off = await signUpAndSignIn(api);
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.slug, off.username));
    expect((await search(viewer.client, off.username)).channels).toEqual([]);
    expect((await search(adult.client, off.username)).channels.map((c) => c.slug)).toEqual([off.username]);
  });

  test("categories by name, with their live counts", async () => {
    const r = await search(client(api), "Cov Speedruns");
    expect(r.categories.map((c) => [c.slug, c.liveChannels])).toEqual([[catSlug, 2]]);
  });
});

describe("directory.ranking", () => {
  test("version, config and explanation", async () => {
    const r = await client(api).call<{ version: string; config: Record<string, unknown>; explanation: string }>(
      "GET",
      "/api/directory/ranking",
    );
    expect(r.status).toBe(200);
    expect(r.body.version.length).toBeGreaterThan(0);
    expect(Object.keys(r.body.config).length).toBeGreaterThan(0);
    expect(r.body.explanation).toContain("score");
  });
});

describe("categories", () => {
  type Cat = { slug: string; liveChannels: number };
  test("busiest first, offset pages, name search, LIKE escaping, 404 for unknown", async () => {
    const all = await client(api).call<{ items: Cat[]; nextCursor: string | null }>("GET", "/api/categories?limit=100");
    expect(all.status).toBe(200);
    expect(all.body.items[0]?.slug).toBe(catSlug);
    expect(all.body.nextCursor).toBeNull();

    const p1 = await client(api).call<{ items: Cat[]; nextCursor: string | null }>(
      "GET",
      "/api/categories?limit=1&q=Cov",
    );
    expect(p1.body.items.map((c) => c.slug)).toEqual([catSlug]);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await client(api).call<{ items: Cat[]; nextCursor: string | null }>(
      "GET",
      `/api/categories?limit=1&q=Cov&cursor=${encodeURIComponent(p1.body.nextCursor ?? "")}`,
    );
    expect(p2.body.items.map((c) => c.slug)).toEqual([otherCatSlug]);
    expect(p2.body.nextCursor).toBeNull();

    expect((await client(api).call<{ items: Cat[] }>("GET", "/api/categories?q=%25")).body.items).toEqual([]);
    expect((await client(api).call<{ items: Cat[] }>("GET", "/api/categories?q=%20%20")).status).toBe(200);
    expect((await client(api).call("GET", "/api/categories/no-such-category")).status).toBe(404);
  });
});
