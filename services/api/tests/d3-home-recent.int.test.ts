// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.listRecent` and `clips.listRecent` (wave 2, D3.1): across every channel, only what an
 * anonymous caller may watch (no private, subscriber-only, processing, removed or restricted media,
 * no suspended channel or banned owner); mature only with `includeMature` and a confirmed adult;
 * the channel card filled; keyset (and, for top clips, offset) pages; language filter.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Card = {
  id: string;
  channelSlug: string;
  category: { slug: string; name: string } | null;
  channel: { id: string; slug: string; displayName: string; avatarUrl: string | null };
  playlistUrl?: string | null;
  thumbnailUrl?: string | null;
  url?: string | null;
  vodId?: string | null;
  windowStartedAt?: string | null;
};
type Page = { items: Card[]; nextCursor: string | null };

let api: TestApi;
let adult: User;
let young: User;

beforeAll(async () => {
  api = await startApi();
  [adult, young] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api, { birthDate: `${new Date().getUTCFullYear() - 15}-01-01` }),
  ]);
  const confirmed = await adult.client.call("POST", "/api/me/mature-confirmation");
  if (confirmed.status !== 200) throw new Error(`mature confirmation: ${confirmed.status}`);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const anon = () => client(api);
const ids = (p: Page) => p.items.map((i) => i.id).sort();
const DAY = 86_400_000;

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function streamer() {
  const u = await signUpAndSignIn(api);
  return { u, c: await channelOf(u.username) };
}

async function category(opts: { mature?: boolean } = {}) {
  const slug = `rc-${uuidv7().slice(-12)}`;
  const [c] = await db()
    .insert(schema.categories)
    .values({ slug, name: `Cat ${slug}`, mature: opts.mature ?? false })
    .returning();
  if (!c) throw new Error("no category");
  return c;
}

async function broadcast(
  channelId: string,
  opts: { categoryId?: string | null; restricted?: boolean; mature?: boolean; rehearsal?: boolean } = {},
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
      ...(opts.rehearsal ? { kind: "rehearsal" as const } : {}),
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
      thumbnailKey: `vods/${id}/thumb.jpg`,
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
      startOffset: 30,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
      ...c,
    });
  return id;
}

/** Everything the list holds right now (the database is this file's own). */
async function walk(path: string, caller = anon(), limit = 2): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n++) {
    const sep = path.includes("?") ? "&" : "?";
    const q: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const p = await caller.call<Page>("GET", `${path}${sep}limit=${limit}${q}`);
    if (p.status !== 200) throw new Error(`${path}: ${p.status}`);
    seen.push(...p.body.items.map((i) => i.id));
    cursor = p.body.nextCursor;
    if (!cursor) break;
  }
  return seen;
}

describe("vods.listRecent", () => {
  test("public, ready, playable videos across channels, newest first, with the channel card", async () => {
    const cat = await category();
    const matureCat = await category({ mature: true });
    const [s1, s2, suspended, banned, matureChan] = await Promise.all([
      streamer(),
      streamer(),
      streamer(),
      streamer(),
      streamer(),
    ]);
    const b1 = await broadcast(s1.c.id, { categoryId: cat.id });
    const b2 = await broadcast(s2.c.id);
    const now = Date.now();
    const older = await vod(s1.c.id, b1.id, { createdAt: new Date(now - 2000) });
    const newer = await vod(s2.c.id, b2.id, { createdAt: new Date(now - 1000) });
    // Never listed: private, subscriber-only, processing, removed, restricted, rehearsal.
    await vod(s1.c.id, b1.id, { visibility: "private" });
    await vod(s1.c.id, b1.id, { visibility: "subscribers" });
    await vod(s1.c.id, b1.id, { status: "processing" });
    await vod(s1.c.id, b1.id, { removedReason: "owner" });
    await vod(s1.c.id, (await broadcast(s1.c.id, { restricted: true })).id);
    await vod(suspended.c.id, (await broadcast(suspended.c.id)).id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, suspended.c.id));
    await vod(banned.c.id, (await broadcast(banned.c.id)).id);
    await db().update(schema.users).set({ banned: true }).where(eq(schema.users.id, banned.u.userId));
    // Mature four ways: the broadcast, the channel, the channel's category, the broadcast's category.
    const matureB = await vod(s2.c.id, (await broadcast(s2.c.id, { mature: true })).id);
    const matureC = await vod(matureChan.c.id, (await broadcast(matureChan.c.id)).id);
    await db().update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, matureChan.c.id));
    const matureCatVod = await vod(s1.c.id, (await broadcast(s1.c.id, { categoryId: matureCat.id })).id);

    const plain = await anon().call<Page>("GET", "/api/vods?limit=100");
    expect(plain.status).toBe(200);
    expect(plain.body.items.map((i) => i.id)).toEqual([newer, older]);
    const first = plain.body.items.find((i) => i.id === older);
    expect(first?.channelSlug).toBe(s1.u.username);
    expect(first?.channel).toMatchObject({ id: s1.c.id, slug: s1.c.slug, displayName: s1.c.displayName });
    expect(first?.category).toEqual({ slug: cat.slug, name: cat.name });
    expect(plain.body.items.find((i) => i.id === newer)?.category).toBeNull();
    // Objects under the public prefix: plain `/media` URLs.
    expect(first?.playlistUrl).toMatch(/index\.m3u8$/);
    expect(first?.thumbnailUrl).toMatch(/thumb\.jpg$/);

    // The owner sees nothing more here than anyone else.
    expect(ids((await s1.u.client.call<Page>("GET", "/api/vods?limit=100")).body)).toEqual([newer, older].sort());

    // includeMature is not enough on its own: anonymous and under-18 callers still get none.
    expect(ids((await anon().call<Page>("GET", "/api/vods?limit=100&includeMature=true")).body)).toEqual(
      [newer, older].sort(),
    );
    expect(ids((await young.client.call<Page>("GET", "/api/vods?limit=100&includeMature=true")).body)).toEqual(
      [newer, older].sort(),
    );
    const asAdult = await adult.client.call<Page>("GET", "/api/vods?limit=100&includeMature=true");
    expect(ids(asAdult.body)).toEqual([newer, older, matureB, matureC, matureCatVod].sort());
    expect(asAdult.body.items.every((i) => i.playlistUrl !== null)).toBe(true);
    // Without asking, an adult gets the safe list too.
    expect(ids((await adult.client.call<Page>("GET", "/api/vods?limit=100")).body)).toEqual([newer, older].sort());
  });

  test("a public VOD whose objects are still moving gets a token-checked URL", async () => {
    const { c } = await streamer();
    const id = uuidv7();
    await db()
      .insert(schema.vods)
      .values({
        id,
        channelId: c.id,
        broadcastId: (await broadcast(c.id)).id,
        title: "still moving",
        storagePrefix: `recordings/${id}/`,
        thumbnailKey: `recordings/${id}/thumb.jpg`,
        status: "ready",
        durationSeconds: 60,
      });
    const page = await anon().call<Page>("GET", "/api/vods?limit=100");
    const item = page.body.items.find((i) => i.id === id);
    expect(item).toBeDefined();
    expect(item?.playlistUrl).toMatch(/index\.m3u8\?t=/);
    expect(item?.thumbnailUrl).toMatch(/thumb\.jpg\?t=/);
  });

  test("pages newest first with a keyset cursor and filters by language", async () => {
    const [a, b] = await Promise.all([streamer(), streamer()]);
    await db().update(schema.channels).set({ language: "es" }).where(eq(schema.channels.id, b.c.id));
    const ba = await broadcast(a.c.id);
    const bb = await broadcast(b.c.id);
    const base = Date.now() + 10 * DAY;
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const [c, br] = i % 2 === 0 ? [a.c, ba] : [b.c, bb];
      made.push(await vod(c.id, br.id, { createdAt: new Date(base - i * 1000) }));
    }
    const seen = await walk("/api/vods");
    expect(seen.slice(0, 5)).toEqual(made);
    expect(new Set(seen).size).toBe(seen.length);
    const es = await walk("/api/vods?language=es", anon(), 1);
    expect(es).toEqual(made.filter((_, i) => i % 2 === 1));
    expect((await anon().call("GET", "/api/vods?cursor=nonsense")).status).toBe(400);
  });
});

describe("clips.listRecent", () => {
  test("ready clips of public broadcasts across channels, with the channel card", async () => {
    const cat = await category();
    const [s1, s2, suspended] = await Promise.all([streamer(), streamer(), streamer()]);
    const b1 = await broadcast(s1.c.id, { categoryId: cat.id });
    const b2 = await broadcast(s2.c.id);
    const shown1 = await clip(s1.c.id, b1.id, { creatorId: s2.u.userId });
    const shown2 = await clip(s2.c.id, b2.id);
    await clip(s1.c.id, b1.id, { status: "processing" });
    await clip(s1.c.id, b1.id, { removedReason: "creator" });
    await clip(s1.c.id, (await broadcast(s1.c.id, { restricted: true })).id);
    await clip(s1.c.id, (await broadcast(s1.c.id, { rehearsal: true })).id);
    // A clip of a private VOD follows it.
    const privB = await broadcast(s2.c.id);
    await clip(s2.c.id, privB.id, { vodId: await vod(s2.c.id, privB.id, { visibility: "private" }) });
    await clip(suspended.c.id, (await broadcast(suspended.c.id)).id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, suspended.c.id));
    const mature = await clip(s2.c.id, (await broadcast(s2.c.id, { mature: true })).id);

    const plain = await anon().call<Page>("GET", "/api/clips?limit=100");
    expect(plain.status).toBe(200);
    expect(ids(plain.body)).toEqual([shown1, shown2].sort());
    const one = plain.body.items.find((i) => i.id === shown1);
    expect(one?.channel.slug).toBe(s1.c.slug);
    expect(one?.category).toEqual({ slug: cat.slug, name: cat.name });
    expect(one?.url).toMatch(/\.mp4$/);
    expect(one?.windowStartedAt).toBe(new Date(b1.startedAt.getTime() + 30_000).toISOString());
    expect((one as unknown as { creator: { username: string } }).creator.username).toBe(s2.u.username);

    expect(ids((await anon().call<Page>("GET", "/api/clips?limit=100&includeMature=true")).body)).toEqual(
      [shown1, shown2].sort(),
    );
    const asAdult = await adult.client.call<Page>("GET", "/api/clips?limit=100&includeMature=true");
    expect(ids(asAdult.body)).toEqual([shown1, shown2, mature].sort());
    expect(asAdult.body.items.find((i) => i.id === mature)?.url).toMatch(/\.mp4$/);
  });

  test("top and recent sorts, ranges and paging", async () => {
    const [a, b] = await Promise.all([streamer(), streamer()]);
    const ba = await broadcast(a.c.id);
    const bb = await broadcast(b.c.id);
    const now = Date.now();
    // Far enough in the future that they lead the recent sort over this file's other clips.
    const fresh = await clip(a.c.id, ba.id, { views: 1_000_001, createdAt: new Date(now + 20 * DAY) });
    const week = await clip(b.c.id, bb.id, { views: 1_000_050, createdAt: new Date(now - 10 * DAY) });
    const old = await clip(a.c.id, ba.id, { views: 1_000_100, createdAt: new Date(now - 40 * DAY) });
    const get = (q: string) => anon().call<Page>("GET", `/api/clips?${q}`);
    expect((await get("sort=top&limit=3")).body.items.map((i) => i.id)).toEqual([old, week, fresh]);
    expect((await get("sort=top&range=30d&limit=2")).body.items.map((i) => i.id)).toEqual([week, fresh]);
    expect((await get("sort=recent&limit=1")).body.items.map((i) => i.id)).toEqual([fresh]);
    const recent = await walk("/api/clips?sort=recent", anon(), 1);
    expect(recent.indexOf(fresh)).toBeLessThan(recent.indexOf(week));
    expect(recent.indexOf(week)).toBeLessThan(recent.indexOf(old));
    const p1 = await get("sort=top&limit=2");
    expect(p1.body.items.map((i) => i.id)).toEqual([old, week]);
    const p2 = await get(`sort=top&limit=1&cursor=${encodeURIComponent(p1.body.nextCursor ?? "")}`);
    expect(p2.body.items.map((i) => i.id)).toEqual([fresh]);
  });
});
