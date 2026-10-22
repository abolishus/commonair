// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * VOD and clip management (docs/testing/e6-selectors.md "VODs and clips"): rename, re-scope and
 * remove; `NOT_FOUND` (never `FORBIDDEN`) for anyone who may not manage the item; removal hides the
 * item and its broadcast's clips at once; `private` and `subscribers` visibility.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let s: User;
let v: User;
let sub: User;

beforeAll(async () => {
  api = await startApi();
  [s, v, sub] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const c = await channelOf(s.username);
  await db().insert(schema.subscriptions).values({
    subscriberId: sub.userId,
    channelId: c.id,
    tier: 1,
    status: "active",
    provider: "manual",
    priceCents: 500,
    currency: "usd",
  });
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type Page<T> = { items: T[]; nextCursor: string | null };
type VodOut = { id: string; title: string; visibility: string };

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function broadcast(channelId: string) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(),
    })
    .returning();
  if (!b) throw new Error("no broadcast");
  return b;
}

async function vod(channelId: string, broadcastId: string, over: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({ id, channelId, broadcastId, title: "v", storagePrefix: `vods/${id}/`, status: "ready", ...over });
  return id;
}

async function clip(channelId: string, broadcastId: string, creatorId: string | null, vodId: string | null = null) {
  const id = uuidv7();
  await db()
    .insert(schema.clips)
    .values({
      id,
      channelId,
      broadcastId,
      vodId,
      creatorId,
      title: "c",
      startOffset: 0,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
    });
  return id;
}

const vodIds = async (who: User | null, slug: string) =>
  (await (who ? who.client : client(api)).call<Page<VodOut>>("GET", `/api/channels/${slug}/vods`)).body.items.map(
    (i) => i.id,
  );
const clipIds = async (who: User | null, slug: string) =>
  (
    await (who ? who.client : client(api)).call<Page<{ id: string }>>("GET", `/api/channels/${slug}/clips`)
  ).body.items.map((i) => i.id);

async function audits(action: string, subjectId: string) {
  return db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));
}

describe("vods.update", () => {
  test("the owner renames and re-scopes; strangers get NOT_FOUND; an audit row", async () => {
    const c = await channelOf(s.username);
    const b = await broadcast(c.id);
    const id = await vod(c.id, b.id);
    const r = await s.client.call<VodOut>("PATCH", `/api/vods/${id}`, { title: "  New title ", visibility: "private" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id, title: "New title", visibility: "private" });
    const [a] = await audits("vod.update", id);
    expect(a?.actorId).toBe(s.userId);
    expect(a?.details).toEqual({ titleChanged: true, visibility: "private" });

    // Private: only the owner lists and reads it.
    expect(await vodIds(s, s.username)).toContain(id);
    expect(await vodIds(v, s.username)).not.toContain(id);
    expect(await vodIds(sub, s.username)).not.toContain(id);
    expect((await v.client.call("GET", `/api/vods/${id}`)).status).toBe(404);
    expect((await s.client.call("GET", `/api/vods/${id}`)).status).toBe(200);

    // Someone else's VOD, a missing one, signed out: no existence leak.
    expect((await v.client.call("PATCH", `/api/vods/${id}`, { title: "x" })).status).toBe(404);
    expect((await v.client.call("DELETE", `/api/vods/${id}`)).status).toBe(404);
    expect((await s.client.call("PATCH", `/api/vods/${uuidv7()}`, { title: "x" })).status).toBe(404);
    expect((await client(api).call("PATCH", `/api/vods/${id}`, { title: "x" })).status).toBe(401);
    expect((await s.client.call("PATCH", `/api/vods/${id}`, { title: "   " })).status).toBe(400);
  });

  test("subscribers: the owner and active subscribers only", async () => {
    const c = await channelOf(s.username);
    const b = await broadcast(c.id);
    const id = await vod(c.id, b.id, { visibility: "subscribers" });
    expect(await vodIds(s, s.username)).toContain(id);
    expect(await vodIds(sub, s.username)).toContain(id);
    expect(await vodIds(v, s.username)).not.toContain(id);
    expect(await vodIds(null, s.username)).not.toContain(id);
    expect((await sub.client.call("GET", `/api/vods/${id}`)).status).toBe(200);
    expect((await v.client.call("GET", `/api/vods/${id}`)).status).toBe(404);
    expect((await client(api).call("GET", `/api/vods/${id}`)).status).toBe(404);
    // Back to public: everyone.
    await s.client.call("PATCH", `/api/vods/${id}`, { visibility: "public" });
    expect(await vodIds(null, s.username)).toContain(id);
  });
});

describe("vods.remove", () => {
  test("hides the VOD and every clip of its broadcast at once; expires it for the worker", async () => {
    const c = await channelOf(s.username);
    const b = await broadcast(c.id);
    const other = await broadcast(c.id);
    const id = await vod(c.id, b.id);
    const fromVod = await clip(c.id, b.id, v.userId, id);
    const fromLive = await clip(c.id, b.id, s.userId);
    const unrelated = await clip(c.id, other.id, v.userId);

    expect((await s.client.call("DELETE", `/api/vods/${id}`)).status).toBe(200);
    for (const who of [s, v, null]) {
      expect(await vodIds(who, s.username)).not.toContain(id);
      const clips = await clipIds(who, s.username);
      expect(clips).not.toContain(fromVod);
      expect(clips).not.toContain(fromLive);
      expect(clips).toContain(unrelated);
    }
    expect((await s.client.call("GET", `/api/vods/${id}`)).status).toBe(404);
    expect((await s.client.call("GET", `/api/clips/${fromVod}`)).status).toBe(404);

    const [row] = await db().select().from(schema.vods).where(eq(schema.vods.id, id));
    expect(row?.removedReason).toBe("owner");
    expect(row?.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
    // The worker deletes objects and sets `deleted`; the API leaves the status alone.
    expect(row?.status).toBe("ready");
    const clipRows = await db().select().from(schema.clips).where(eq(schema.clips.broadcastId, b.id));
    expect(clipRows.every((x) => x.removedReason === "owner")).toBe(true);
    const [a] = await audits("vod.remove", id);
    expect(a?.details).toEqual({ clips: 2 });

    // Gone for good: further management is NOT_FOUND.
    expect((await s.client.call("DELETE", `/api/vods/${id}`)).status).toBe(404);
    expect((await s.client.call("PATCH", `/api/vods/${id}`, { title: "back" })).status).toBe(404);
  });
});

describe("clips.remove", () => {
  test("the channel owner removes anyone's clip; the creator their own; strangers NOT_FOUND", async () => {
    const c = await channelOf(s.username);
    const b = await broadcast(c.id);
    const byV = await clip(c.id, b.id, v.userId);
    const byV2 = await clip(c.id, b.id, v.userId);
    const bySub = await clip(c.id, b.id, sub.userId);

    // A stranger (neither owner nor creator).
    expect((await v.client.call("DELETE", `/api/clips/${bySub}`)).status).toBe(404);
    expect((await v.client.call("DELETE", `/api/clips/${uuidv7()}`)).status).toBe(404);

    expect((await s.client.call("DELETE", `/api/clips/${byV}`)).status).toBe(200);
    expect((await v.client.call("DELETE", `/api/clips/${byV2}`)).status).toBe(200);
    for (const who of [s, v, null]) {
      const ids = await clipIds(who, s.username);
      expect(ids).not.toContain(byV);
      expect(ids).not.toContain(byV2);
      expect(ids).toContain(bySub);
    }
    expect((await client(api).call("GET", `/api/clips/${byV}`)).status).toBe(404);
    expect((await s.client.call("GET", `/api/clips/${byV}`)).status).toBe(404);

    const rows = await db().select().from(schema.clips).where(eq(schema.clips.broadcastId, b.id));
    expect(rows.find((x) => x.id === byV)?.removedReason).toBe("owner");
    expect(rows.find((x) => x.id === byV2)?.removedReason).toBe("creator");
    expect((await audits("clip.remove", byV))[0]?.details).toEqual({ by: "owner" });
    expect((await audits("clip.remove", byV2))[0]?.details).toEqual({ by: "creator" });

    // Twice: already gone.
    expect((await s.client.call("DELETE", `/api/clips/${byV}`)).status).toBe(404);
    expect((await client(api).call("DELETE", `/api/clips/${bySub}`)).status).toBe(401);
  });
});

describe("clips follow their source VOD's visibility", () => {
  test("a subscriber's clip of a subscribers VOD stays with the owner and subscribers", async () => {
    const c = await channelOf(s.username);
    const b = await broadcast(c.id);
    const id = await vod(c.id, b.id, { visibility: "subscribers", durationSeconds: 600 });
    const r = await sub.client.call<{ id: string }>("POST", `/api/channels/${s.username}/clips`, {
      title: "sub only",
      vodId: id,
      startOffset: 0,
      durationSeconds: 30,
    });
    expect(r.status).toBe(200);
    const clipId = r.body.id;
    // As if media had cut it.
    await db()
      .update(schema.clips)
      .set({ status: "ready", storageKey: `clips/${clipId}.mp4` })
      .where(eq(schema.clips.id, clipId));

    expect(await clipIds(s, s.username)).toContain(clipId);
    expect(await clipIds(sub, s.username)).toContain(clipId);
    expect(await clipIds(v, s.username)).not.toContain(clipId);
    expect(await clipIds(null, s.username)).not.toContain(clipId);
    expect((await sub.client.call("GET", `/api/clips/${clipId}`)).status).toBe(200);
    expect((await v.client.call("GET", `/api/clips/${clipId}`)).status).toBe(404);
    expect((await client(api).call("GET", `/api/clips/${clipId}`)).status).toBe(404);
  });

  test("clips of a VOD later set private (cut from it or live) are hidden from all but the owner", async () => {
    const c = await channelOf(s.username);
    const b = await broadcast(c.id);
    const id = await vod(c.id, b.id);
    const fromVod = await clip(c.id, b.id, v.userId, id);
    const fromLive = await clip(c.id, b.id, v.userId);
    expect(await clipIds(null, s.username)).toEqual(expect.arrayContaining([fromVod, fromLive]));

    expect((await s.client.call("PATCH", `/api/vods/${id}`, { visibility: "private" })).status).toBe(200);
    for (const who of [v, sub, null]) {
      const ids = await clipIds(who, s.username);
      expect(ids).not.toContain(fromVod);
      expect(ids).not.toContain(fromLive);
    }
    expect((await client(api).call("GET", `/api/clips/${fromVod}`)).status).toBe(404);
    expect((await sub.client.call("GET", `/api/clips/${fromLive}`)).status).toBe(404);
    expect(await clipIds(s, s.username)).toEqual(expect.arrayContaining([fromVod, fromLive]));
    expect((await s.client.call("GET", `/api/clips/${fromVod}`)).status).toBe(200);

    // Back to public: everyone again.
    await s.client.call("PATCH", `/api/vods/${id}`, { visibility: "public" });
    expect(await clipIds(null, s.username)).toEqual(expect.arrayContaining([fromVod, fromLive]));
  });
});
