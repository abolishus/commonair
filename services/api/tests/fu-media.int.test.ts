// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * VOD and clip DTOs carry their broadcast's category; `vods.listByCategory` and
 * `clips.listByCategory` show across channels what an anonymous caller may see (no private,
 * subscriber-only, processing, removed or restricted media, no suspended channel; mature only with
 * `includeMature`); `clips.list` filters by a 7- or 30-day window on the database clock.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { setClipQueue } from "../src/media/clip-queue.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Cat = { slug: string; name: string } | null;
type Item = {
  id: string;
  channelSlug: string;
  category: Cat;
  url?: string | null;
  playlistUrl?: string | null;
};
type Page = { items: Item[]; nextCursor: string | null };

let api: TestApi;
let alice: User;
let bob: User;
let adult: User;

beforeAll(async () => {
  api = await startApi();
  setClipQueue(api.deps, {
    async enqueue() {},
    async close() {},
  });
  [alice, bob, adult] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const confirmed = await adult.client.call("POST", "/api/me/mature-confirmation");
  if (confirmed.status !== 200) throw new Error(`mature confirmation: ${confirmed.status}`);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function category(opts: { mature?: boolean } = {}) {
  const slug = `fu-${uuidv7().slice(-12)}`;
  const [c] = await db()
    .insert(schema.categories)
    .values({ slug, name: `Cat ${slug}`, mature: opts.mature ?? false })
    .returning();
  if (!c) throw new Error("no category");
  return c;
}

async function broadcast(
  channelId: string,
  opts: { categoryId?: string | null; restricted?: boolean; mature?: boolean } = {},
) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(),
      categoryId: opts.categoryId ?? null,
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
      mature: opts.mature ?? false,
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  return b;
}

async function vod(channelId: string, broadcastId: string, v: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({
      id,
      channelId,
      broadcastId,
      title: "v",
      storagePrefix: `vods/${id}/`,
      status: "ready",
      durationSeconds: 120,
      ...v,
    });
  return id;
}

async function clip(channelId: string, broadcastId: string, c: Partial<typeof schema.clips.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.clips)
    .values({
      id,
      channelId,
      broadcastId,
      title: "c",
      startOffset: 0,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
      ...c,
    });
  return id;
}

/** A fresh streamer with its channel row. */
async function streamer() {
  const u = await signUpAndSignIn(api);
  return { u, c: await channelOf(u.username) };
}

const ids = (p: Page) => p.items.map((i) => i.id).sort();
const anon = () => client(api);

describe("category on VOD and clip DTOs", () => {
  test("every read and write carries the broadcast's category; none without one", async () => {
    const cat = await category();
    const c = await channelOf(alice.username);
    const inCat = await broadcast(c.id, { categoryId: cat.id });
    const none = await broadcast(c.id);
    const v1 = await vod(c.id, inCat.id);
    const v2 = await vod(c.id, none.id);
    const ref = { slug: cat.slug, name: cat.name };

    const list = await anon().call<Page>("GET", `/api/channels/${alice.username}/vods`);
    const byId = new Map(list.body.items.map((i) => [i.id, i.category]));
    expect(byId.get(v1)).toEqual(ref);
    expect(byId.get(v2)).toBeNull();
    expect((await anon().call<Item>("GET", `/api/vods/${v1}`)).body.category).toEqual(ref);
    expect((await anon().call<Item>("GET", `/api/vods/${v2}`)).body.category).toBeNull();
    const renamed = await alice.client.call<Item>("PATCH", `/api/vods/${v1}`, { title: "renamed" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.category).toEqual(ref);
    const unchanged = await alice.client.call<Item>("PATCH", `/api/vods/${v2}`, {});
    expect(unchanged.body.category).toBeNull();

    const made = await bob.client.call<Item>("POST", `/api/channels/${alice.username}/clips`, {
      vodId: v1,
      startOffset: 0,
      durationSeconds: 5,
      title: "cut",
    });
    expect(made.status).toBe(200);
    expect(made.body.category).toEqual(ref);
    const madeNone = await bob.client.call<Item>("POST", `/api/channels/${alice.username}/clips`, {
      vodId: v2,
      startOffset: 0,
      durationSeconds: 5,
      title: "cut",
    });
    expect(madeNone.body.category).toBeNull();

    const k1 = await clip(c.id, inCat.id);
    const k2 = await clip(c.id, none.id);
    const clipsList = await anon().call<Page>("GET", `/api/channels/${alice.username}/clips?limit=100`);
    const clipCat = new Map(clipsList.body.items.map((i) => [i.id, i.category]));
    expect(clipCat.get(k1)).toEqual(ref);
    expect(clipCat.get(k2)).toBeNull();
    expect((await anon().call<Item>("GET", `/api/clips/${k1}`)).body.category).toEqual(ref);
    expect((await anon().call<Item>("GET", `/api/clips/${k2}`)).body.category).toBeNull();
  });
});

describe("vods.listByCategory", () => {
  test("only what an anonymous caller may watch, across channels; mature only with includeMature", async () => {
    const cat = await category();
    const other = await category();
    const matureCat = await category({ mature: true });
    const [s1, s2, suspended, matureChan, labelledChan] = await Promise.all([
      streamer(),
      streamer(),
      streamer(),
      streamer(),
      streamer(),
    ]);
    const b1 = await broadcast(s1.c.id, { categoryId: cat.id });
    const b2 = await broadcast(s2.c.id, { categoryId: cat.id });
    const shown1 = await vod(s1.c.id, b1.id);
    const shown2 = await vod(s2.c.id, b2.id);
    await vod(s1.c.id, b1.id, { visibility: "private" });
    await vod(s1.c.id, b1.id, { visibility: "subscribers" });
    await vod(s1.c.id, b1.id, { status: "processing" });
    await vod(s1.c.id, b1.id, { removedReason: "owner" });
    await vod(s1.c.id, (await broadcast(s1.c.id, { categoryId: cat.id, restricted: true })).id);
    await vod(s1.c.id, (await broadcast(s1.c.id, { categoryId: other.id })).id);
    await vod(s1.c.id, (await broadcast(s1.c.id)).id);
    await vod(suspended.c.id, (await broadcast(suspended.c.id, { categoryId: cat.id })).id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, suspended.c.id));
    const matureBroadcast = await vod(s2.c.id, (await broadcast(s2.c.id, { categoryId: cat.id, mature: true })).id);
    const matureChannel = await vod(matureChan.c.id, (await broadcast(matureChan.c.id, { categoryId: cat.id })).id);
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, matureChan.c.id));
    // The channel's own category labels its media mature too.
    const matureLabel = await vod(labelledChan.c.id, (await broadcast(labelledChan.c.id, { categoryId: cat.id })).id);
    await db()
      .update(schema.channels)
      .set({ categoryId: matureCat.id })
      .where(eq(schema.channels.id, labelledChan.c.id));

    const plain = await anon().call<Page>("GET", `/api/categories/${cat.slug}/vods?limit=100`);
    expect(plain.status).toBe(200);
    expect(ids(plain.body)).toEqual([shown1, shown2].sort());
    expect(plain.body.items.every((i) => i.category?.slug === cat.slug)).toBe(true);
    expect(plain.body.items.find((i) => i.id === shown1)?.channelSlug).toBe(s1.u.username);
    expect(plain.body.items.find((i) => i.id === shown1)?.playlistUrl).toMatch(/index\.m3u8$/);
    // The owner sees nothing more here than anyone else.
    const own = await s1.u.client.call<Page>("GET", `/api/categories/${cat.slug}/vods?limit=100`);
    expect(ids(own.body)).toEqual([shown1, shown2].sort());

    const all = [shown1, shown2, matureBroadcast, matureChannel, matureLabel].sort();
    const withMature = await anon().call<Page>("GET", `/api/categories/${cat.slug}/vods?limit=100&includeMature=true`);
    expect(ids(withMature.body)).toEqual(all);
    // Listed, but an anonymous caller gets no URLs for mature media; a confirmed adult does.
    expect(withMature.body.items.find((i) => i.id === matureBroadcast)?.playlistUrl).toBeNull();
    const asAdult = await adult.client.call<Page>(
      "GET",
      `/api/categories/${cat.slug}/vods?limit=100&includeMature=true`,
    );
    expect(ids(asAdult.body)).toEqual(all);
    for (const id of [matureBroadcast, matureChannel, matureLabel])
      expect(asAdult.body.items.find((i) => i.id === id)?.playlistUrl).toMatch(/index\.m3u8$/);
    // The owner of a mature channel always gets its URLs.
    const ownMature = await matureChan.u.client.call<Page>(
      "GET",
      `/api/categories/${cat.slug}/vods?limit=100&includeMature=true`,
    );
    expect(ownMature.body.items.find((i) => i.id === matureChannel)?.playlistUrl).toMatch(/index\.m3u8$/);
    expect(ownMature.body.items.find((i) => i.id === matureBroadcast)?.playlistUrl).toBeNull();
  });

  test("a mature category lists nothing without includeMature; an unknown one is 404", async () => {
    const cat = await category({ mature: true });
    const { c } = await streamer();
    const v = await vod(c.id, (await broadcast(c.id, { categoryId: cat.id })).id);
    expect((await anon().call<Page>("GET", `/api/categories/${cat.slug}/vods`)).body.items).toEqual([]);
    expect(ids((await anon().call<Page>("GET", `/api/categories/${cat.slug}/vods?includeMature=true`)).body)).toEqual([
      v,
    ]);
    expect((await anon().call("GET", "/api/categories/no-such-category-x/vods")).status).toBe(404);
  });

  test("pages newest first with a keyset cursor", async () => {
    const cat = await category();
    const [a, b] = await Promise.all([streamer(), streamer()]);
    const ba = await broadcast(a.c.id, { categoryId: cat.id });
    const bb = await broadcast(b.c.id, { categoryId: cat.id });
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [c, br] = i % 2 === 0 ? [a.c, ba] : [b.c, bb];
      made.push(await vod(c.id, br.id, { createdAt: new Date(Date.now() - i * 1000) }));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 5; n++) {
      const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const p = await anon().call<Page>("GET", `/api/categories/${cat.slug}/vods?limit=2${q}`);
      seen.push(...p.body.items.map((i) => i.id));
      cursor = p.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(made);
  });
});

describe("clips.listByCategory", () => {
  test("only what an anonymous caller may watch, across channels; mature only with includeMature", async () => {
    const cat = await category();
    const other = await category();
    const [s1, s2, suspended] = await Promise.all([streamer(), streamer(), streamer()]);
    const b1 = await broadcast(s1.c.id, { categoryId: cat.id });
    const b2 = await broadcast(s2.c.id, { categoryId: cat.id });
    const shown1 = await clip(s1.c.id, b1.id);
    const shown2 = await clip(s2.c.id, b2.id);
    await clip(s1.c.id, b1.id, { status: "processing" });
    await clip(s1.c.id, b1.id, { removedReason: "creator" });
    await clip(s1.c.id, (await broadcast(s1.c.id, { categoryId: other.id })).id);
    await clip(s1.c.id, (await broadcast(s1.c.id, { categoryId: cat.id, restricted: true })).id);
    // A clip of a private VOD follows it.
    const privB = await broadcast(s2.c.id, { categoryId: cat.id });
    const privV = await vod(s2.c.id, privB.id, { visibility: "private" });
    await clip(s2.c.id, privB.id, { vodId: privV });
    await clip(suspended.c.id, (await broadcast(suspended.c.id, { categoryId: cat.id })).id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, suspended.c.id));
    const mature = await clip(s2.c.id, (await broadcast(s2.c.id, { categoryId: cat.id, mature: true })).id);

    const plain = await anon().call<Page>("GET", `/api/categories/${cat.slug}/clips?limit=100`);
    expect(plain.status).toBe(200);
    expect(ids(plain.body)).toEqual([shown1, shown2].sort());
    expect(plain.body.items.every((i) => i.category?.slug === cat.slug)).toBe(true);
    const withMature = await anon().call<Page>("GET", `/api/categories/${cat.slug}/clips?limit=100&includeMature=true`);
    expect(ids(withMature.body)).toEqual([shown1, shown2, mature].sort());
    expect(withMature.body.items.find((i) => i.id === mature)?.url).toBeNull();
    const asAdult = await adult.client.call<Page>(
      "GET",
      `/api/categories/${cat.slug}/clips?limit=100&includeMature=true`,
    );
    expect(asAdult.body.items.find((i) => i.id === mature)?.url).toMatch(/\.mp4$/);
    expect((await anon().call("GET", "/api/categories/no-such-category-x/clips")).status).toBe(404);
  });

  test("top and recent sorts, ranges and paging", async () => {
    const cat = await category();
    const [a, b] = await Promise.all([streamer(), streamer()]);
    const ba = await broadcast(a.c.id, { categoryId: cat.id });
    const bb = await broadcast(b.c.id, { categoryId: cat.id });
    const now = Date.now();
    const fresh = await clip(a.c.id, ba.id, { views: 1, createdAt: new Date(now - HOUR) });
    const week = await clip(b.c.id, bb.id, { views: 50, createdAt: new Date(now - 10 * DAY) });
    const old = await clip(a.c.id, ba.id, { views: 100, createdAt: new Date(now - 40 * DAY) });
    const get = (q: string) => anon().call<Page>("GET", `/api/categories/${cat.slug}/clips?${q}`);
    expect((await get("sort=top")).body.items.map((i) => i.id)).toEqual([old, week, fresh]);
    expect((await get("sort=recent")).body.items.map((i) => i.id)).toEqual([fresh, week, old]);
    expect((await get("sort=top&range=30d")).body.items.map((i) => i.id)).toEqual([week, fresh]);
    expect((await get("sort=recent&range=7d")).body.items.map((i) => i.id)).toEqual([fresh]);
    const p1 = await get("sort=top&limit=2");
    expect(p1.body.items.map((i) => i.id)).toEqual([old, week]);
    const p2 = await get(`sort=top&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor ?? "")}`);
    expect(p2.body.items.map((i) => i.id)).toEqual([fresh]);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe("clips.list range", () => {
  test("7d and 30d cut on the database clock at their edges; all keeps everything; with both sorts and paging", async () => {
    const { u, c } = await streamer();
    const b = await broadcast(c.id);
    // Placed against the database's own now(), an hour either side of each edge.
    const at = async (ms: number, views: number) => {
      const id = await clip(c.id, b.id, { views });
      await db()
        .update(schema.clips)
        .set({ createdAt: sql`now() - make_interval(secs => ${ms / 1000})` })
        .where(eq(schema.clips.id, id));
      return id;
    };
    const in7 = await at(7 * DAY - HOUR, 10);
    const out7 = await at(7 * DAY + HOUR, 40);
    const in30 = await at(30 * DAY - HOUR, 30);
    const out30 = await at(30 * DAY + HOUR, 20);
    const get = (q: string) => anon().call<Page>("GET", `/api/channels/${u.username}/clips?${q}`);
    const order = async (q: string) => (await get(q)).body.items.map((i) => i.id);
    expect(await order("range=7d")).toEqual([in7]);
    expect(await order("range=30d")).toEqual([in7, out7, in30]);
    expect(await order("range=all")).toEqual([in7, out7, in30, out30]);
    expect(await order("")).toEqual([in7, out7, in30, out30]);
    expect(await order("sort=top&range=30d")).toEqual([out7, in30, in7]);
    expect(await order("sort=top&range=7d")).toEqual([in7]);
    expect((await get("range=1y")).status).toBe(400);

    const walk = async (q: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let n = 0; n < 5; n++) {
        const extra: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const p = await get(`${q}&limit=1${extra}`);
        seen.push(...p.body.items.map((i) => i.id));
        cursor = p.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    expect(await walk("range=30d")).toEqual([in7, out7, in30]);
    expect(await walk("sort=top&range=30d")).toEqual([out7, in30, in7]);
  });
});
