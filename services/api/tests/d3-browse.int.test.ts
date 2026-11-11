// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul D3 browse: `Category.videoCount` (public, ready videos recorded in the category, counted
 * as `vods.listByCategory` lists them by default) and search v2's `videos` (newest first) and
 * `clips` (most viewed first), which follow the public visibility rules and the channel results'
 * mature rule: nothing mature for anyone who has not confirmed 18+.
 *
 * This file owns its database (`startApi` → `createTestDatabase()`), so every row here is its own.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

type Category = { slug: string; videoCount: number; liveChannels: number };
type VodCard = {
  id: string;
  title: string;
  channelSlug: string;
  thumbnailUrl: string | null;
  playlistUrl: string | null;
  captions: unknown[];
  category: { slug: string; name: string } | null;
  channel: { id: string; slug: string; displayName: string; accent: string };
};
type ClipCard = {
  id: string;
  title: string;
  views: number;
  url: string | null;
  creator: { username: string } | null;
  windowStartedAt: string | null;
  vodId: string | null;
  channel: { slug: string };
};
type Search = { channels: unknown[]; categories: Category[]; videos: VodCard[]; clips: ClipCard[] };

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

async function streamer() {
  const u = await signUpAndSignIn(api);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, u.username));
  if (!c) throw new Error("no channel");
  return { u, c };
}

async function broadcast(
  channelId: string,
  opts: { categoryId?: string | null; mature?: boolean; restricted?: boolean; startedAt?: Date } = {},
) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      categoryId: opts.categoryId ?? null,
      mature: opts.mature ?? false,
      startedAt: opts.startedAt ?? new Date(Date.now() - 3_600_000),
      endedAt: new Date(),
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  return b;
}

let minute = 0;
async function vod(channelId: string, broadcastId: string, v: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  minute += 1;
  await db()
    .insert(schema.vods)
    .values({
      id,
      channelId,
      broadcastId,
      title: "v",
      storagePrefix: `vods/${id}/`,
      thumbnailKey: `vods/${id}/thumb.jpg`,
      status: "ready",
      visibility: "public",
      durationSeconds: 120,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, minute)),
      ...v,
    });
  return id;
}

async function clip(channelId: string, broadcastId: string | null, c: Partial<typeof schema.clips.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.clips)
    .values({
      id,
      channelId,
      broadcastId,
      title: "c",
      startOffset: 30,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
      ...c,
    });
  return id;
}

const search = async (who: Client, q: string) => {
  const r = await who.call<Search>("GET", `/api/search?q=${encodeURIComponent(q)}&limit=50`);
  expect(r.status).toBe(200);
  return r.body;
};

describe("Category.videoCount", () => {
  const slug = "d3b-pottery";
  const other = "d3b-knitting";
  const night = "d3b-night";
  let ids: Record<string, string>;

  beforeAll(async () => {
    const cats = await db()
      .insert(schema.categories)
      .values([
        { slug, name: "D3B Pottery" },
        { slug: other, name: "D3B Knitting" },
        { slug: night, name: "D3B Night", mature: true },
      ])
      .returning();
    ids = Object.fromEntries(cats.map((c) => [c.slug, c.id]));
    const [a, b, suspended, matureChannel] = await Promise.all([streamer(), streamer(), streamer(), streamer()]);
    const pottery = await broadcast(a.c.id, { categoryId: ids[slug] });
    const pottery2 = await broadcast(b.c.id, { categoryId: ids[slug] });
    // Counted: two public, ready videos from two channels.
    await vod(a.c.id, pottery.id);
    await vod(b.c.id, pottery2.id);
    // Not counted: private, subscribers-only, processing, owner-removed.
    await vod(a.c.id, pottery.id, { visibility: "private" });
    await vod(a.c.id, pottery.id, { visibility: "subscribers" });
    await vod(a.c.id, pottery.id, { status: "processing" });
    await vod(a.c.id, pottery.id, { removedReason: "owner" });
    // Not counted: a mature broadcast, a restricted one, a suspended channel, a mature channel.
    await vod(a.c.id, (await broadcast(a.c.id, { categoryId: ids[slug], mature: true })).id);
    await vod(a.c.id, (await broadcast(a.c.id, { categoryId: ids[slug], restricted: true })).id);
    await vod(suspended.c.id, (await broadcast(suspended.c.id, { categoryId: ids[slug] })).id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, suspended.c.id));
    await vod(matureChannel.c.id, (await broadcast(matureChannel.c.id, { categoryId: ids[slug] })).id);
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, matureChannel.c.id));
    // The broadcast's category counts, not the channel's: this one is Knitting.
    await db()
      .update(schema.channels)
      .set({ categoryId: ids[slug] ?? null })
      .where(eq(schema.channels.id, b.c.id));
    await vod(b.c.id, (await broadcast(b.c.id, { categoryId: ids[other] })).id);
    // A mature category counts nothing, as its liveChannels.
    await vod(a.c.id, (await broadcast(a.c.id, { categoryId: ids[night] })).id);
  }, 120_000);

  test("get, list and search report the same count, equal to the default videos listing", async () => {
    const anon = client(api);
    const one = await anon.call<Category>("GET", `/api/categories/${slug}`);
    expect(one.status).toBe(200);
    expect(one.body.videoCount).toBe(2);
    const listed = await anon.call<{ items: Category[] }>("GET", "/api/categories?limit=100");
    const counts = new Map(listed.body.items.map((c) => [c.slug, c.videoCount]));
    expect(counts.get(slug)).toBe(2);
    expect(counts.get(other)).toBe(1);
    expect(counts.get(night)).toBe(0);
    const found = await search(anon, "D3B");
    expect(new Map(found.categories.map((c) => [c.slug, c.videoCount]))).toEqual(
      counts.size ? new Map([...counts].filter(([s]) => s.startsWith("d3b-"))) : new Map(),
    );
    for (const s of [slug, other]) {
      const page = await anon.call<{ items: unknown[] }>("GET", `/api/categories/${s}/vods?limit=50`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBe(counts.get(s));
    }
  });

  test("a category with no videos reads 0", async () => {
    await db().insert(schema.categories).values({ slug: "d3b-empty", name: "D3B Empty" });
    const r = await client(api).call<Category>("GET", "/api/categories/d3b-empty");
    expect(r.body.videoCount).toBe(0);
  });
});

describe("search videos and clips", () => {
  let adult: Client;
  let owner: Awaited<ReturnType<typeof streamer>>;
  let newest = "";
  let older = "";
  let hidden: Record<string, string> = {};
  let topClip = "";
  let midClip = "";
  let matureVod = "";
  let matureClip = "";

  beforeAll(async () => {
    owner = await streamer();
    const [other, suspended, banned, adultUser] = await Promise.all([
      streamer(),
      streamer(),
      streamer(),
      signUpAndSignIn(api),
    ]);
    adult = adultUser.client;
    const ok = await adult.call("POST", "/api/me/mature-confirmation");
    if (ok.status !== 200) throw new Error(`mature confirmation: ${ok.status}`);
    const [cat] = await db().insert(schema.categories).values({ slug: "d3b-glaze", name: "D3B Glaze" }).returning();
    const b = await broadcast(owner.c.id, { categoryId: cat?.id ?? null, startedAt: new Date("2026-10-01T10:00:00Z") });
    older = await vod(owner.c.id, b.id, { title: "Glaze firing day one" });
    newest = await vod(other.c.id, (await broadcast(other.c.id)).id, {
      title: "Second glaze firing",
      // Still on the private prefix: listed, but no URL without a token.
      storagePrefix: "recordings/x/",
    });
    // Hidden videos on a broadcast of their own: a private or removed video hides its broadcast's clips too.
    const hb = await broadcast(owner.c.id);
    hidden = {
      private: await vod(owner.c.id, hb.id, { title: "glaze private", visibility: "private" }),
      processing: await vod(owner.c.id, hb.id, { title: "glaze processing", status: "processing" }),
      dmca: await vod(owner.c.id, hb.id, { title: "glaze dmca", removedReason: "dmca" }),
      restricted: await vod(owner.c.id, (await broadcast(owner.c.id, { restricted: true })).id, {
        title: "glaze restricted",
      }),
      suspended: await vod(suspended.c.id, (await broadcast(suspended.c.id)).id, { title: "glaze suspended" }),
      banned: await vod(banned.c.id, (await broadcast(banned.c.id)).id, { title: "glaze banned" }),
      unrelated: await vod(owner.c.id, hb.id, { title: "Wheel throwing" }),
    };
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, suspended.c.id));
    await db().update(schema.users).set({ banned: true }).where(eq(schema.users.id, banned.c.ownerId));
    const matureB = await broadcast(owner.c.id, { mature: true });
    matureVod = await vod(owner.c.id, matureB.id, { title: "glaze after dark" });

    topClip = await clip(owner.c.id, b.id, { title: "Glaze drip", views: 90, creatorId: other.c.ownerId });
    midClip = await clip(other.c.id, null, { title: "the glaze moment", views: 10 });
    hidden.clipProcessing = await clip(owner.c.id, b.id, { title: "glaze cutting", status: "processing" });
    hidden.clipRemoved = await clip(owner.c.id, b.id, { title: "glaze removed", removedReason: "creator" });
    // A clip is no more visible than its source video.
    const privB = await broadcast(owner.c.id);
    await vod(owner.c.id, privB.id, { title: "source", visibility: "private" });
    hidden.clipPrivateSource = await clip(owner.c.id, privB.id, { title: "glaze from private" });
    hidden.clipSuspended = await clip(suspended.c.id, null, { title: "glaze suspended clip" });
    matureClip = await clip(owner.c.id, matureB.id, { title: "glaze mature clip", views: 50 });
  }, 120_000);

  test("videos: title matches only, public and ready, newest first, as cards with their channel", async () => {
    const r = await search(client(api), "glaze");
    expect(r.videos.map((v) => v.id)).toEqual([newest, older]);
    const [second, first] = r.videos;
    expect(first?.channel.slug).toBe(owner.c.slug);
    expect(first?.channelSlug).toBe(owner.c.slug);
    expect(first?.category).toEqual({ slug: "d3b-glaze", name: "D3B Glaze" });
    expect(first?.thumbnailUrl).toMatch(/\/thumb\.jpg$/);
    expect(first?.playlistUrl).toMatch(/index\.m3u8$/);
    expect(first?.captions).toEqual([]);
    // Not on the public prefix yet: no URLs (a card mints no token).
    expect(second?.thumbnailUrl).toBeNull();
    expect(second?.playlistUrl).toBeNull();
    expect(second?.category).toBeNull();
    for (const id of Object.values(hidden)) expect(r.videos.map((v) => v.id)).not.toContain(id);
  });

  test("clips: ready and visible only, most viewed first, with their creator and window", async () => {
    const r = await search(client(api), "glaze");
    expect(r.clips.map((c) => c.id)).toEqual([topClip, midClip]);
    const [top, mid] = r.clips;
    expect(top?.url).toMatch(/\.mp4$/);
    expect(top?.creator).not.toBeNull();
    expect(top?.windowStartedAt).toBe("2026-10-01T10:00:30.000Z");
    expect(top?.vodId).toBeNull();
    // Cut from a broadcast that is gone: no window.
    expect(mid?.windowStartedAt).toBeNull();
  });

  test("mature items go only to confirmed adults, with their URLs", async () => {
    const anon = await search(client(api), "glaze");
    expect(anon.videos.map((v) => v.id)).not.toContain(matureVod);
    expect(anon.clips.map((c) => c.id)).not.toContain(matureClip);
    const grown = await search(adult, "glaze");
    expect(grown.videos.map((v) => v.id)).toContain(matureVod);
    expect(grown.clips.map((c) => c.id)).toEqual([topClip, matureClip, midClip]);
    expect(grown.clips[1]?.url).not.toBeNull();
  });

  test("every word in any order matches, and LIKE characters are literal", async () => {
    expect((await search(client(api), "firing glaze")).videos.map((v) => v.id)).toEqual([newest, older]);
    expect((await search(client(api), "gl%ze")).videos).toEqual([]);
    expect((await search(client(api), "_laze")).clips).toEqual([]);
  });

  test("the limit caps each list", async () => {
    const r = await client(api).call<Search>("GET", "/api/search?q=glaze&limit=1");
    expect(r.body.videos.map((v) => v.id)).toEqual([newest]);
    expect(r.body.clips.map((c) => c.id)).toEqual([topClip]);
  });
});
