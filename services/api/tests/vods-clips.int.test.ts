// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vods.*` and `clips.*` reads and `clips.create`. Removed (T0, NCII, deletion) and T1-restricted
 * media must never be listed or readable, by the owner or anyone else; the trust-safety scenario
 * relies on these lists to show a T0 channel's VODs and clips are gone.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { setClipQueue } from "../src/media/clip-queue.ts";
import { LIVE_CLIP_LAG_SECONDS } from "../src/routes/clips.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
let bob: Awaited<ReturnType<typeof signUpAndSignIn>>;
const enqueued: string[] = [];
let enqueueFails = false;

beforeAll(async () => {
  api = await startApi();
  setClipQueue(api.deps, {
    async enqueue(id) {
      if (enqueueFails) throw new Error("valkey down");
      enqueued.push(id);
    },
    async close() {},
  });
  [alice, bob] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type Page<T> = { items: T[]; nextCursor: string | null };
type Item = { id: string; status: string; url?: string | null; playlistUrl?: string | null };

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function broadcast(
  channelId: string,
  opts: { live?: boolean; restricted?: boolean; startedAgoS?: number; mature?: boolean } = {},
) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - (opts.startedAgoS ?? 600) * 1000),
      endedAt: opts.live ? null : new Date(),
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
      mature: opts.mature ?? false,
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  // Playback (and clipping) find the live broadcast through the channel.
  if (opts.live)
    await db().update(schema.channels).set({ liveBroadcastId: b.id }).where(eq(schema.channels.id, channelId));
  return b;
}

async function vod(
  channelId: string,
  broadcastId: string,
  v: Partial<typeof schema.vods.$inferInsert> = {},
): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({ id, channelId, broadcastId, title: "v", storagePrefix: `vods/${id}/`, status: "ready", ...v });
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

const ids = (p: Page<Item>) => p.items.map((i) => i.id).sort();

describe("vods", () => {
  test("public sees ready public VODs; the owner also sees processing and private; nobody sees removed or restricted", async () => {
    const c = await channelOf(alice.username);
    const b = await broadcast(c.id);
    const r = await broadcast(c.id, { restricted: true });
    const ready = await vod(c.id, b.id);
    const processing = await vod(c.id, b.id, { status: "processing" });
    const priv = await vod(c.id, b.id, { visibility: "private" });
    const t0 = await vod(c.id, b.id, { status: "deleted", removedReason: "t0_hash_match" });
    const underReview = await vod(c.id, r.id);

    const pub = await client(api).call<Page<Item>>("GET", `/api/channels/${alice.username}/vods`);
    expect(pub.status).toBe(200);
    expect(ids(pub.body)).toEqual([ready]);
    expect(pub.body.items[0]?.playlistUrl).toMatch(new RegExp(`/vods/${ready}/index\\.m3u8$`));
    const own = await alice.client.call<Page<Item>>("GET", `/api/channels/${alice.username}/vods`);
    expect(ids(own.body)).toEqual([ready, processing, priv].sort());
    const other = await bob.client.call<Page<Item>>("GET", `/api/channels/${alice.username}/vods`);
    expect(ids(other.body)).toEqual([ready]);

    for (const id of [t0, underReview]) {
      expect((await alice.client.call("GET", `/api/vods/${id}`)).status).toBe(404);
      expect((await client(api).call("GET", `/api/vods/${id}`)).status).toBe(404);
    }
    for (const id of [processing, priv]) {
      expect((await alice.client.call("GET", `/api/vods/${id}`)).status).toBe(200);
      expect((await bob.client.call("GET", `/api/vods/${id}`)).status).toBe(404);
    }
    expect((await client(api).call("GET", `/api/vods/${ready}`)).status).toBe(200);
  });

  test("pages newest first with a keyset cursor", async () => {
    const c = await channelOf(bob.username);
    const b = await broadcast(c.id);
    const made: string[] = [];
    for (let i = 0; i < 3; i++) made.push(await vod(c.id, b.id, { createdAt: new Date(Date.now() - i * 1000) }));
    const p1 = await client(api).call<Page<Item>>("GET", `/api/channels/${bob.username}/vods?limit=2`);
    expect(p1.body.items.map((i) => i.id)).toEqual(made.slice(0, 2));
    const p2 = await client(api).call<Page<Item>>(
      "GET",
      `/api/channels/${bob.username}/vods?limit=2&cursor=${p1.body.nextCursor}`,
    );
    expect(p2.body.items.map((i) => i.id)).toEqual(made.slice(2));
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe("clips", () => {
  test("removed and restricted clips are hidden from everyone; processing only from the public", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id);
    const r = await broadcast(c.id, { restricted: true });
    const ready = await clip(c.id, b.id);
    const processing = await clip(c.id, b.id, { status: "processing", storageKey: null });
    const ncii = await clip(c.id, b.id, { status: "deleted", removedReason: "ncii_deadline" });
    const underReview = await clip(c.id, r.id);

    const pub = await client(api).call<Page<Item>>("GET", `/api/channels/${owner.username}/clips`);
    expect(ids(pub.body)).toEqual([ready]);
    expect(pub.body.items[0]?.url).toMatch(new RegExp(`/clips/${ready}\\.mp4$`));
    const own = await owner.client.call<Page<Item>>("GET", `/api/channels/${owner.username}/clips`);
    expect(ids(own.body)).toEqual([ready, processing].sort());
    const top = await client(api).call<Page<Item>>("GET", `/api/channels/${owner.username}/clips?sort=top`);
    expect(ids(top.body)).toEqual([ready]);

    for (const id of [ncii, underReview]) {
      expect((await owner.client.call("GET", `/api/clips/${id}`)).status).toBe(404);
      expect((await client(api).call("GET", `/api/clips/${id}`)).status).toBe(404);
    }
    const own1 = await owner.client.call<Item>("GET", `/api/clips/${processing}`);
    expect(own1.body).toMatchObject({ status: "processing", url: null });
    expect((await client(api).call("GET", `/api/clips/${processing}`)).status).toBe(404);
  });

  test("a suspended channel lists nothing publicly and cannot be clipped", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id, { live: true });
    const ready = await clip(c.id, b.id);
    await db()
      .update(schema.channels)
      .set({ suspendedAt: new Date(), suspendedReason: "t0_hash_match" })
      .where(eq(schema.channels.id, c.id));
    const pub = await client(api).call<Page<Item>>("GET", `/api/channels/${owner.username}/clips`);
    expect(pub.body.items).toEqual([]);
    expect((await client(api).call("GET", `/api/clips/${ready}`)).status).toBe(404);
    const made = await bob.client.call<{ code: string }>("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      durationSeconds: 5,
    });
    expect(made.status).toBe(412);
  });

  test("clipping a live stream records the last seconds and enqueues the cut for media", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id, { live: true, startedAgoS: 120 });
    const res = await bob.client.call<Item & { creator: { username: string } }>(
      "POST",
      `/api/channels/${owner.username}/clips`,
      { title: "nice", durationSeconds: 10 },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "processing", url: null, creator: { username: bob.username } });
    expect(enqueued).toContain(res.body.id);
    const [row] = await db().select().from(schema.clips).where(eq(schema.clips.id, res.body.id));
    expect(row?.broadcastId).toBe(b.id);
    // Ends LIVE_CLIP_LAG_SECONDS behind the live edge, where media's recorder has finished segments.
    expect(row?.startOffset).toBeGreaterThan(120 - LIVE_CLIP_LAG_SECONDS - 10 - 5);
    expect(row?.startOffset).toBeLessThan(120 - LIVE_CLIP_LAG_SECONDS - 10 + 5);
  });

  test("an offline or under-review stream cannot be clipped", async () => {
    const owner = await signUpAndSignIn(api);
    const offline = await bob.client.call("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      durationSeconds: 5,
    });
    expect(offline.status).toBe(412);
    const c = await channelOf(owner.username);
    await broadcast(c.id, { live: true, restricted: true });
    const review = await bob.client.call("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      durationSeconds: 5,
    });
    expect(review.status).toBe(412);
    expect((await client(api).call("POST", `/api/channels/${owner.username}/clips`, { title: "x" })).status).toBe(401);
  });

  test("a clip of a VOD must lie inside it and the VOD must be visible to the clipper", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id);
    const v = await vod(c.id, b.id, { durationSeconds: 60 });
    const priv = await vod(c.id, b.id, { durationSeconds: 60, visibility: "private" });
    const ok = await bob.client.call<Item>("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      vodId: v,
      startOffset: 30,
      durationSeconds: 10,
    });
    expect(ok.status).toBe(200);
    const outside = await bob.client.call("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      vodId: v,
      startOffset: 55,
      durationSeconds: 10,
    });
    expect(outside.status).toBe(412);
    const hidden = await bob.client.call("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      vodId: priv,
      durationSeconds: 10,
    });
    expect(hidden.status).toBe(404);
  });

  test("a clip whose broadcast's VOD was removed is hidden, even one cut from the live buffer", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const removed = await broadcast(c.id);
    const expired = await broadcast(c.id);
    await vod(c.id, removed.id, { status: "deleted", removedReason: "ncii" });
    await vod(c.id, expired.id, { status: "deleted", removedReason: "retention" });
    const liveBuffer = await clip(c.id, removed.id, { vodId: null });
    const kept = await clip(c.id, expired.id, { vodId: null });
    const own = await owner.client.call<Page<Item>>("GET", `/api/channels/${owner.username}/clips`);
    expect(ids(own.body)).toEqual([kept]);
    expect((await client(api).call("GET", `/api/clips/${liveBuffer}`)).status).toBe(404);
    expect((await owner.client.call("GET", `/api/clips/${liveBuffer}`)).status).toBe(404);
  });

  test("mature media URLs go only to the owner and confirmed adults; others may not clip it", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const live = await broadcast(c.id, { live: true, mature: true });
    const v = await vod(c.id, live.id);
    const k = await clip(c.id, live.id);
    const anonVod = await client(api).call<Item & { thumbnailUrl: string | null }>("GET", `/api/vods/${v}`);
    expect(anonVod.status).toBe(200);
    expect(anonVod.body).toMatchObject({ playlistUrl: null, thumbnailUrl: null });
    const anonClip = await client(api).call<Item>("GET", `/api/clips/${k}`);
    expect(anonClip.body).toMatchObject({ status: "ready", url: null });
    const ownClip = await owner.client.call<Item>("GET", `/api/clips/${k}`);
    expect(ownClip.body.url).toMatch(/\.mp4$/);

    const viewer = await signUpAndSignIn(api);
    const refused = await viewer.client.call<{ code: string; data: { reason: string } }>(
      "POST",
      `/api/channels/${owner.username}/clips`,
      { title: "x", durationSeconds: 5 },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.data.reason).toBe("mature_gate");
    expect((await viewer.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    const listed = await viewer.client.call<Page<Item>>("GET", `/api/channels/${owner.username}/clips`);
    expect(listed.body.items[0]?.url).toMatch(/\.mp4$/);
    const made = await viewer.client.call("POST", `/api/channels/${owner.username}/clips`, {
      title: "x",
      durationSeconds: 5,
    });
    expect(made.status).toBe(200);
  });

  test("when the cut cannot be queued the clip is marked failed and the error is generic", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    await broadcast(c.id, { live: true });
    enqueueFails = true;
    try {
      const r = await bob.client.call<{ message: string }>("POST", `/api/channels/${owner.username}/clips`, {
        title: "x",
        durationSeconds: 5,
      });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toContain("valkey");
    } finally {
      enqueueFails = false;
    }
    const rows = await db().select().from(schema.clips).where(eq(schema.clips.channelId, c.id));
    expect(rows.map((r) => r.status)).toEqual(["failed"]);
  });
});
