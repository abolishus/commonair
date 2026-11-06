// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Follow-up fields on channel and directory DTOs: `Channel.lastLiveAt` and `Channel.socials`,
 * `ChannelCard.latestVod` on the front page's offline sections, and `Category.viewerCount` /
 * `Category.tags` over the category's listed live streams.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { KEYS, mediaPath } from "@commonair/contracts/internal";
import { vodPrefix } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { mediaUrl } from "../src/lib/dto.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
const users = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function broadcast(
  slug: string,
  opts: {
    endedAt?: Date | null;
    kind?: "live" | "rehearsal";
    categoryId?: string | null;
    mature?: boolean;
    restricted?: boolean;
    live?: boolean;
  } = {},
): Promise<string> {
  const c = await channelOf(slug);
  const endedAt = opts.endedAt === undefined ? new Date() : opts.endedAt;
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId: c.id,
      ingestProtocol: "rtmp",
      path: mediaPath(slug),
      title: `${slug} show`,
      kind: opts.kind ?? "live",
      categoryId: opts.categoryId ?? null,
      mature: opts.mature ?? false,
      startedAt: new Date((endedAt ?? new Date()).getTime() - 3_600_000),
      endedAt,
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
    })
    .returning();
  if (!b) throw new Error("broadcast insert returned no row");
  if (opts.live) await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, c.id));
  return b.id;
}

describe("Channel.lastLiveAt", () => {
  type Channel = { lastLiveAt: string | null; live: unknown };
  const get = async (slug: string) => {
    const r = await client(api).call<Channel>("GET", `/api/channels/${slug}`);
    expect(r.status).toBe(200);
    return r.body;
  };

  test("null without broadcasts, null while only live, the newest ended broadcast otherwise", async () => {
    const [never, liveOnly, ended] = await users(3);
    if (!never || !liveOnly || !ended) throw new Error("signup");
    expect((await get(never.username)).lastLiveAt).toBeNull();

    await broadcast(liveOnly.username, { endedAt: null, live: true });
    const live = await get(liveOnly.username);
    expect(live.live).not.toBeNull();
    expect(live.lastLiveAt).toBeNull();

    const older = new Date(Date.now() - 5 * 3_600_000);
    const newer = new Date(Date.now() - 2 * 3_600_000);
    await broadcast(ended.username, { endedAt: older });
    await broadcast(ended.username, { endedAt: newer });
    // A rehearsal is private: it never makes the channel look recently live.
    await broadcast(ended.username, { endedAt: new Date(), kind: "rehearsal" });
    // Going live again keeps the last ended broadcast's time.
    await broadcast(ended.username, { endedAt: null, live: true });
    expect((await get(ended.username)).lastLiveAt).toBe(newer.toISOString());
  });
});

describe("Channel.socials", () => {
  type Social = { platform: string; url: string };
  type Channel = { socials: Social[] };

  test("update stores the list in order and get returns it; an update replaces it", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const fresh = await client(api).call<Channel>("GET", `/api/channels/${owner.username}`);
    expect(fresh.body.socials).toEqual([]);

    const socials = [
      { platform: "mastodon", url: "https://social.example/@me" },
      { platform: "website", url: "https://me.example/" },
    ];
    const up = await owner.client.call<Channel>("PATCH", `/api/channels/${owner.username}`, { socials });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.socials).toEqual(socials);
    const read = await client(api).call<Channel>("GET", `/api/channels/${owner.username}`);
    expect(read.body.socials).toEqual(socials);

    // Leaving socials out keeps them; an empty list clears them.
    await owner.client.call("PATCH", `/api/channels/${owner.username}`, { title: "new title" });
    expect((await client(api).call<Channel>("GET", `/api/channels/${owner.username}`)).body.socials).toEqual(socials);
    const cleared = await owner.client.call<Channel>("PATCH", `/api/channels/${owner.username}`, { socials: [] });
    expect(cleared.body.socials).toEqual([]);
  });

  test("the contract refuses a non-https link and stores nothing", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const bad = await owner.client.call("PATCH", `/api/channels/${owner.username}`, {
      socials: [{ platform: "website", url: "http://insecure.example/" }],
    });
    expect(bad.status).toBe(400);
    expect((await channelOf(owner.username)).socials).toEqual([]);
  });

  test("invalid stored entries are dropped on read", async () => {
    const [owner] = await users(1);
    if (!owner) throw new Error("signup");
    const good = { platform: "github", url: "https://code.example/me" };
    await db()
      .update(schema.channels)
      .set({
        socials: [
          { platform: "website", url: "http://insecure.example/" },
          { platform: "myspace", url: "https://old.example/" },
          "not an object",
          good,
          { platform: "x", url: "https://user:pw@x.example/" },
        ] as never,
      })
      .where(eq(schema.channels.slug, owner.username));
    const r = await client(api).call<Channel>("GET", `/api/channels/${owner.username}`);
    expect(r.status).toBe(200);
    expect(r.body.socials).toEqual([good]);

    await db()
      .update(schema.channels)
      .set({ socials: { not: "an array" } as never })
      .where(eq(schema.channels.slug, owner.username));
    expect((await client(api).call<Channel>("GET", `/api/channels/${owner.username}`)).body.socials).toEqual([]);
  });
});

describe("ChannelCard.latestVod", () => {
  type LatestVod = { id: string; thumbnailUrl: string | null; durationSeconds: number } | null;
  type Card = { channel: { slug: string }; latestVod: LatestVod };
  type Home = { recentlyLive: Card[]; followingOffline: Card[] };

  async function vod(
    slug: string,
    broadcastId: string,
    over: Partial<typeof schema.vods.$inferInsert> = {},
    at: "public" | "private" = "public",
  ) {
    const c = await channelOf(slug);
    const id = uuidv7();
    const prefix = vodPrefix(id, at);
    await db()
      .insert(schema.vods)
      .values({
        id,
        channelId: c.id,
        broadcastId,
        title: "v",
        storagePrefix: prefix,
        thumbnailKey: `${prefix}thumbnail.webp`,
        status: "ready",
        durationSeconds: 120,
        ...over,
      });
    return { id, thumb: `${prefix}thumbnail.webp` };
  }

  test("newest ready public VOD per card; private, processing and removed VODs skipped; none is null", async () => {
    const [picked, skipped, none, moving, mature, viewer] = await users(6);
    if (!picked || !skipped || !none || !moving || !mature || !viewer) throw new Error("signup");
    const t = (h: number) => new Date(Date.now() - h * 3_600_000);

    const pb1 = await broadcast(picked.username, { endedAt: t(10) });
    const pb2 = await broadcast(picked.username, { endedAt: t(3) });
    await vod(picked.username, pb1, { createdAt: t(9), durationSeconds: 60 });
    const newest = await vod(picked.username, pb2, { createdAt: t(2), durationSeconds: 3725.5 });
    // Newer, but nobody may watch these.
    await vod(picked.username, pb2, { createdAt: t(1), visibility: "private" }, "private");
    await vod(picked.username, pb2, { createdAt: t(1), visibility: "subscribers" }, "private");

    const sb = await broadcast(skipped.username, { endedAt: t(4) });
    await vod(skipped.username, sb, { status: "processing" }, "private");
    await vod(skipped.username, sb, { removedReason: "owner" }, "private");
    await vod(skipped.username, sb, { status: "deleted" }, "private");
    const restricted = await broadcast(skipped.username, { endedAt: t(5), restricted: true });
    await vod(skipped.username, restricted, {}, "private");

    await broadcast(none.username, { endedAt: t(6) });

    // Public and ready, but its objects are still under the private prefix: no thumbnail yet.
    const mb = await broadcast(moving.username, { endedAt: t(7) });
    const stillMoving = await vod(moving.username, mb, { durationSeconds: 30 }, "private");

    // An older mature broadcast's VOD under a newer, unlabelled broadcast: listed, thumbnail withheld.
    const old = await broadcast(mature.username, { endedAt: t(8), mature: true });
    const matureVod = await vod(mature.username, old);
    await broadcast(mature.username, { endedAt: t(7.5) });

    for (const slug of [picked.username, skipped.username, none.username, moving.username])
      await viewer.client.call("PUT", `/api/channels/${slug}/follow`, {});

    const home = await viewer.client.call<Home>("GET", "/api/directory");
    expect(home.status).toBe(200);
    const card = (cards: Card[], slug: string) => cards.find((c) => c.channel.slug === slug);
    for (const cards of [home.body.recentlyLive, home.body.followingOffline]) {
      expect(card(cards, picked.username)?.latestVod).toEqual({
        id: newest.id,
        thumbnailUrl: mediaUrl(api.deps, newest.thumb),
        durationSeconds: 3725.5,
      });
      expect(card(cards, skipped.username)?.latestVod).toBeNull();
      expect(card(cards, none.username)?.latestVod).toBeNull();
      expect(card(cards, moving.username)?.latestVod).toEqual({
        id: stillMoving.id,
        thumbnailUrl: null,
        durationSeconds: 30,
      });
    }
    expect(card(home.body.recentlyLive, mature.username)?.latestVod).toEqual({
      id: matureVod.id,
      thumbnailUrl: null,
      durationSeconds: 120,
    });

    expect((await viewer.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    const adult = await viewer.client.call<Home>("GET", "/api/directory");
    expect(card(adult.body.recentlyLive, mature.username)?.latestVod?.thumbnailUrl).toBe(
      mediaUrl(api.deps, matureVod.thumb),
    );
  });

  test("a VOD of a channel whose own category is mature keeps its thumbnail from non-adults", async () => {
    const [owner, viewer] = await users(2);
    if (!owner || !viewer) throw new Error("signup");
    const suffix = uuidv7().slice(-8);
    const [adultCat, plainCat] = await db()
      .insert(schema.categories)
      .values([
        { slug: `fu-vod-adult-${suffix}`, name: `FU Adult ${suffix}`, mature: true },
        { slug: `fu-vod-plain-${suffix}`, name: `FU Plain ${suffix}`, mature: false },
      ])
      .returning();
    if (!adultCat || !plainCat) throw new Error("category insert");
    await db().update(schema.channels).set({ categoryId: adultCat.id }).where(eq(schema.channels.slug, owner.username));
    // The last broadcast is in an unlabelled category, so the card itself is listed.
    const b = await broadcast(owner.username, { endedAt: new Date(Date.now() - 60_000), categoryId: plainCat.id });
    const v = await vod(owner.username, b);

    const card = (h: Home) => h.recentlyLive.find((c) => c.channel.slug === owner.username);
    const home = await viewer.client.call<Home>("GET", "/api/directory");
    expect(card(home.body)?.latestVod).toEqual({ id: v.id, thumbnailUrl: null, durationSeconds: 120 });

    expect((await viewer.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    const adult = await viewer.client.call<Home>("GET", "/api/directory");
    expect(card(adult.body)?.latestVod?.thumbnailUrl).toBe(mediaUrl(api.deps, v.thumb));
  });
});

describe("Category.viewerCount and Category.tags", () => {
  type Category = { slug: string; liveChannels: number; viewerCount: number; tags: string[] };
  const games = "fu-games";
  const quiet = "fu-quiet";
  const night = "fu-night";
  let gamesId = "";

  async function stream(
    u: User,
    categoryId: string,
    viewers: number,
    tags: string[],
    opts: { mature?: boolean; restricted?: boolean } = {},
  ) {
    await db().update(schema.channels).set({ tags }).where(eq(schema.channels.slug, u.username));
    await broadcast(u.username, { endedAt: null, live: true, categoryId, ...opts });
    const c = await channelOf(u.username);
    await api.deps.valkey.set(KEYS.viewerCount(c.id), String(viewers), "EX", 600);
  }

  beforeAll(async () => {
    const cats = await db()
      .insert(schema.categories)
      .values([
        { slug: games, name: "FU Games" },
        { slug: quiet, name: "FU Quiet" },
        { slug: night, name: "FU Night", mature: true },
      ])
      .returning();
    const id = (slug: string) => cats.find((c) => c.slug === slug)?.id ?? "";
    gamesId = id(games);
    const [a, b, c, d, e, f, g] = await users(7);
    if (!a || !b || !c || !d || !e || !f || !g) throw new Error("signup");
    // Counted: a, b, c. Tag uses: common 3, shared 2, then nine tags used once (alphabetical).
    await stream(a, gamesId, 10, ["common", "shared", "a1", "a2", "a3", "a4"]);
    await stream(b, gamesId, 25, ["common", "shared", "b1", "b2", "b3"]);
    await stream(c, gamesId, 0, ["common", "c1"]);
    // Not listed by default: restricted, a mature broadcast, a mature channel, a banned owner.
    await stream(d, gamesId, 1000, ["restricted"], { restricted: true });
    await stream(e, gamesId, 1000, ["mature"], { mature: true });
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.slug, f.username));
    await stream(f, gamesId, 1000, ["maturechannel"]);
    // A mature category counts nothing, as its liveChannels does.
    await stream(g, id(night), 500, ["night"]);
  }, 120_000);

  const expectedTags = ["common", "shared", "a1", "a2", "a3", "a4", "b1", "b2", "b3", "c1"];

  test("list sums listed viewers, carries the top ten tags, and empty categories carry none", async () => {
    const r = await client(api).call<{ items: Category[] }>("GET", "/api/categories?limit=100");
    expect(r.status).toBe(200);
    const by = new Map(r.body.items.map((c) => [c.slug, c]));
    expect(by.get(games)).toMatchObject({ liveChannels: 3, viewerCount: 35, tags: expectedTags });
    expect(by.get(quiet)).toMatchObject({ liveChannels: 0, viewerCount: 0, tags: [] });
    expect(by.get(night)).toMatchObject({ liveChannels: 0, viewerCount: 0, tags: [] });
  });

  test("get and search report the same", async () => {
    const one = await client(api).call<Category>("GET", `/api/categories/${games}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ liveChannels: 3, viewerCount: 35, tags: expectedTags });
    const search = await client(api).call<{ categories: Category[] }>("GET", "/api/search?q=FU%20Games");
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(search.body.categories.find((c) => c.slug === games)).toMatchObject({ viewerCount: 35, tags: expectedTags });
  });

  test("tag ties order by name and the cap drops the rest", async () => {
    const [extra] = await users(1);
    if (!extra) throw new Error("signup");
    // "aa" is used once, like the others, but sorts first among them; c1 falls past the cap.
    await stream(extra, gamesId, 5, ["aa", "shared"]);
    const r = await client(api).call<Category>("GET", `/api/categories/${games}`);
    expect(r.body.viewerCount).toBe(40);
    expect(r.body.tags).toEqual(["common", "shared", "a1", "a2", "a3", "a4", "aa", "b1", "b2", "b3"]);
  });

  test("an admin upsert returns the category with the same stats", async () => {
    const [admin] = await users(1);
    if (!admin) throw new Error("signup");
    await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
    const r = await admin.client.call<Category>("PUT", `/api/admin/categories/${games}`, {
      name: "FU Games",
      mature: false,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ slug: games, liveChannels: 4, viewerCount: 40 });
    expect(r.body.tags).toHaveLength(10);
  });
});
