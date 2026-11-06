// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.*` and `clips.*` edges the main suites leave out: unknown channels and ids, failed VODs and
 * their reasons, a suspended channel's lists (empty for others, full for the owner), rehearsal
 * recordings (never public, never clipped), VODs that are not ready, editors and moderators
 * managing media, clips whose broadcast is gone, a mature category's clips, and `top` paging.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { setClipQueue } from "../src/media/clip-queue.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Vod = {
  id: string;
  status: string;
  failedReason: string | null;
  playlistUrl: string | null;
  visibility: string;
  category: { slug: string } | null;
};
type Clip = { id: string; url: string | null; windowStartedAt: string | null; views: number; category: unknown };
type Page<T> = { items: T[]; nextCursor: string | null };

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
  setClipQueue(api.deps, {
    async enqueue() {},
    async close() {},
  });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const anon = () => client(api);

async function streamer() {
  const u = await signUpAndSignIn(api);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, u.username));
  if (!c) throw new Error("no channel");
  return { u, c };
}

async function broadcast(
  channelId: string,
  opts: { kind?: "live" | "rehearsal"; categoryId?: string | null; startedAt?: Date } = {},
) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      kind: opts.kind ?? "live",
      categoryId: opts.categoryId ?? null,
      startedAt: opts.startedAt ?? new Date(Date.now() - 600_000),
      endedAt: new Date(),
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

describe("vods", () => {
  test("unknown channel, VOD or category is 404", async () => {
    expect((await anon().call("GET", "/api/channels/no_such_channel_x/vods")).status).toBe(404);
    expect((await anon().call("GET", `/api/vods/${uuidv7()}`)).status).toBe(404);
    expect((await anon().call("GET", "/api/categories/no-such-category/vods")).status).toBe(404);
  });

  test("a failed VOD carries its known reason (or none) to the owner only", async () => {
    const { u, c } = await streamer();
    const b = await broadcast(c.id);
    const known = await vod(c.id, b.id, { status: "failed", failedReason: "no_segments" });
    const unknown = await vod(c.id, b.id, { status: "failed", failedReason: "disk_on_fire" });
    const list = await u.client.call<Page<Vod>>("GET", `/api/channels/${u.username}/vods`);
    const by = new Map(list.body.items.map((v) => [v.id, v]));
    expect(by.get(known)).toMatchObject({ status: "failed", failedReason: "no_segments", playlistUrl: null });
    expect(by.get(unknown)?.failedReason).toBeNull();
    expect((await anon().call<Page<Vod>>("GET", `/api/channels/${u.username}/vods`)).body.items).toEqual([]);
  });

  test("a suspended channel lists nothing to others; its owner still sees everything", async () => {
    const { u, c } = await streamer();
    const b = await broadcast(c.id);
    const id = await vod(c.id, b.id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, c.id));
    expect((await anon().call<Page<Vod>>("GET", `/api/channels/${u.username}/vods`)).body).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await anon().call("GET", `/api/vods/${id}`)).status).toBe(404);
    const own = await u.client.call<Page<Vod>>("GET", `/api/channels/${u.username}/vods`);
    expect(own.body.items.map((v) => v.id)).toEqual([id]);
    const one = await u.client.call<Vod>("GET", `/api/vods/${id}`);
    expect(one.status).toBe(200);
    // Suspended: not servable, so no playlist even for the owner.
    expect(one.body.playlistUrl).toBeNull();
  });

  test("a rehearsal recording stays private; a no-op update returns the VOD unchanged", async () => {
    const { u, c } = await streamer();
    const b = await broadcast(c.id, { kind: "rehearsal" });
    const id = await vod(c.id, b.id, { visibility: "private" });
    const pub = await u.client.call("PATCH", `/api/vods/${id}`, { visibility: "public" });
    expect(pub.status).toBe(412);
    expect((await u.client.call<Vod>("PATCH", `/api/vods/${id}`, { visibility: "private" })).status).toBe(200);
    const noop = await u.client.call<Vod>("PATCH", `/api/vods/${id}`, {});
    expect(noop.status).toBe(200);
    expect(noop.body).toMatchObject({ id, visibility: "private" });
    expect((await u.client.call("PATCH", `/api/vods/${id}`, { title: "   " })).status).toBe(400);
  });

  test("an editor manages VODs; a moderator may not; anonymous callers are refused", async () => {
    const { u, c } = await streamer();
    const [editor, mod] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await u.client.call("PUT", `/api/channels/${u.username}/roles/${editor.username}`, { role: "editor" });
    await u.client.call("PUT", `/api/channels/${u.username}/roles/${mod.username}`, { role: "moderator" });
    const b = await broadcast(c.id);
    const id = await vod(c.id, b.id);
    expect((await mod.client.call("PATCH", `/api/vods/${id}`, { title: "mod" })).status).toBe(404);
    expect((await mod.client.call("DELETE", `/api/vods/${id}`)).status).toBe(404);
    const renamed = await editor.client.call<{ title: string }>("PATCH", `/api/vods/${id}`, { title: "edited" });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe("edited");
    expect((await editor.client.call("DELETE", `/api/vods/${id}`)).status).toBe(200);
    // Removed: managing it again reads as missing.
    expect((await editor.client.call("DELETE", `/api/vods/${id}`)).status).toBe(404);
    expect((await u.client.call("PATCH", `/api/vods/${id}`, { title: "x" })).status).toBe(404);
    expect((await anon().call("DELETE", `/api/vods/${uuidv7()}`)).status).toBe(401);
  });

  test("listByCategory pages by keyset; a mature category is empty without includeMature", async () => {
    const { c } = await streamer();
    const suffix = uuidv7().slice(-10);
    const [cat, adultCat] = await db()
      .insert(schema.categories)
      .values([
        { slug: `cov-v-${suffix}`, name: `V ${suffix}` },
        { slug: `cov-va-${suffix}`, name: `VA ${suffix}`, mature: true },
      ])
      .returning();
    if (!cat || !adultCat) throw new Error("categories");
    const b = await broadcast(c.id, { categoryId: cat.id });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await vod(c.id, b.id, { createdAt: new Date(Date.now() - (3 - i) * 60_000) }));
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r: { body: Page<Vod> } = await anon().call<Page<Vod>>(
        "GET",
        `/api/categories/${cat.slug}/vods?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...r.body.items.map((v) => v.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([...ids].reverse());

    const ab = await broadcast(c.id, { categoryId: adultCat.id });
    const adultVod = await vod(c.id, ab.id);
    expect((await anon().call<Page<Vod>>("GET", `/api/categories/${adultCat.slug}/vods`)).body).toEqual({
      items: [],
      nextCursor: null,
    });
    const shown = await anon().call<Page<Vod>>("GET", `/api/categories/${adultCat.slug}/vods?includeMature=true`);
    expect(shown.body.items.map((v) => [v.id, v.playlistUrl])).toEqual([[adultVod, null]]);
  });
});

describe("clips.create", () => {
  test("unknown channel 404; rehearsal and unready VODs cannot be clipped", async () => {
    const { u, c } = await streamer();
    const clipper = await signUpAndSignIn(api);
    expect(
      (await clipper.client.call("POST", "/api/channels/no_such_channel_x/clips", { title: "t", durationSeconds: 5 }))
        .status,
    ).toBe(404);
    const rb = await broadcast(c.id, { kind: "rehearsal" });
    const rehearsal = await vod(c.id, rb.id, { visibility: "private" });
    // The owner may see the rehearsal recording, and still may not clip it.
    const r = await u.client.call<{ data?: { requirement?: string } }>("POST", `/api/channels/${u.username}/clips`, {
      title: "t",
      vodId: rehearsal,
      durationSeconds: 5,
    });
    expect(r.status).toBe(412);

    const b = await broadcast(c.id);
    const processing = await vod(c.id, b.id, { status: "processing" });
    const p = await u.client.call("POST", `/api/channels/${u.username}/clips`, {
      title: "t",
      vodId: processing,
      durationSeconds: 5,
    });
    expect(p.status).toBe(412);
    // Another viewer cannot even see a processing VOD.
    const hidden = await clipper.client.call("POST", `/api/channels/${u.username}/clips`, {
      title: "t",
      vodId: processing,
      durationSeconds: 5,
    });
    expect(hidden.status).toBe(404);
  });

  test("a clip of a VOD defaults to its start and carries the broadcast's category and window", async () => {
    const { u, c } = await streamer();
    const clipper = await signUpAndSignIn(api);
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug: `cov-c-${uuidv7().slice(-10)}`, name: "Clip cat" })
      .returning();
    if (!cat) throw new Error("category");
    const startedAt = new Date("2026-10-01T10:00:00.000Z");
    const b = await broadcast(c.id, { categoryId: cat.id, startedAt });
    const id = await vod(c.id, b.id);
    const r = await clipper.client.call<Clip & { category: { slug: string } }>(
      "POST",
      `/api/channels/${u.username}/clips`,
      { title: "from vod", vodId: id, durationSeconds: 10 },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.windowStartedAt).toBe(startedAt.toISOString());
    expect(r.body.category).toEqual({ slug: cat.slug, name: cat.name });
    // Still processing: no URL yet.
    expect(r.body.url).toBeNull();
  });
});

describe("clips reads", () => {
  test("unknown channel, clip or category is 404", async () => {
    expect((await anon().call("GET", "/api/channels/no_such_channel_x/clips")).status).toBe(404);
    expect((await anon().call("GET", `/api/clips/${uuidv7()}`)).status).toBe(404);
    expect((await anon().call("GET", "/api/categories/no-such-category/clips")).status).toBe(404);
  });

  test("a clip whose broadcast is gone has no window and no category but still plays", async () => {
    const { u, c } = await streamer();
    const id = await clip(c.id, null);
    const one = await anon().call<Clip>("GET", `/api/clips/${id}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.windowStartedAt).toBeNull();
    expect(one.body.category).toBeNull();
    expect(one.body.url).not.toBeNull();
    const list = await anon().call<Page<Clip>>("GET", `/api/channels/${u.username}/clips`);
    expect(list.body.items.map((x) => x.id)).toEqual([id]);
  });

  test("a suspended channel's clip reads as missing to others, not to its owner", async () => {
    const { u, c } = await streamer();
    const b = await broadcast(c.id);
    const id = await clip(c.id, b.id);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, c.id));
    expect((await anon().call("GET", `/api/clips/${id}`)).status).toBe(404);
    expect((await anon().call<Page<Clip>>("GET", `/api/channels/${u.username}/clips`)).body.items).toEqual([]);
    expect((await u.client.call("GET", `/api/clips/${id}`)).status).toBe(200);
  });

  test("top sorts by views and pages by offset; a mature category needs includeMature", async () => {
    const { u, c } = await streamer();
    const suffix = uuidv7().slice(-10);
    const [cat] = await db()
      .insert(schema.categories)
      .values({ slug: `cov-ca-${suffix}`, name: `CA ${suffix}`, mature: true })
      .returning();
    if (!cat) throw new Error("category");
    const b = await broadcast(c.id, { categoryId: cat.id });
    const low = await clip(c.id, b.id, { views: 1 });
    const high = await clip(c.id, b.id, { views: 100 });
    const midId = await clip(c.id, b.id, { views: 50 });
    const p1 = await u.client.call<Page<Clip>>("GET", `/api/channels/${u.username}/clips?sort=top&limit=2`);
    expect(p1.body.items.map((x) => x.id)).toEqual([high, midId]);
    expect(p1.body.nextCursor).not.toBeNull();
    const p2 = await u.client.call<Page<Clip>>(
      "GET",
      `/api/channels/${u.username}/clips?sort=top&limit=2&cursor=${encodeURIComponent(p1.body.nextCursor ?? "")}`,
    );
    expect(p2.body).toEqual({ items: [expect.objectContaining({ id: low })], nextCursor: null });

    expect((await anon().call<Page<Clip>>("GET", `/api/categories/${cat.slug}/clips`)).body.items).toEqual([]);
    const shown = await anon().call<Page<Clip>>("GET", `/api/categories/${cat.slug}/clips?includeMature=true&sort=top`);
    expect(shown.body.items.map((x) => [x.id, x.url])).toEqual([
      [high, null],
      [midId, null],
      [low, null],
    ]);
  });
});

describe("clips.remove", () => {
  test("a channel moderator removes a clip; removing it again or an unknown clip is 404", async () => {
    const { u, c } = await streamer();
    const mod = await signUpAndSignIn(api);
    await u.client.call("PUT", `/api/channels/${u.username}/roles/${mod.username}`, { role: "moderator" });
    const b = await broadcast(c.id);
    const id = await clip(c.id, b.id);
    expect((await mod.client.call("DELETE", `/api/clips/${id}`)).status).toBe(200);
    const [row] = await db().select().from(schema.clips).where(eq(schema.clips.id, id));
    expect(row?.removedReason).toBe("owner");
    expect((await mod.client.call("DELETE", `/api/clips/${id}`)).status).toBe(404);
    expect((await mod.client.call("DELETE", `/api/clips/${uuidv7()}`)).status).toBe(404);
  });
});
