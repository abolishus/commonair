// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * VOD playback URLs and placement (ADR 0009 amendment 1; docs/testing/w0-selectors.md "VOD
 * states"): a public VOD under `vods/` plays from `/media`; any other VOD the caller may see plays
 * from the origin's token-checked `/vod/`, with a token for that VOD only, valid for its duration
 * plus an hour (capped at 12 h); `vods.update` (visibility) and `vods.remove` enqueue
 * `vod-placement` after commit, and a failed enqueue never fails the request.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { VOD_TOKEN_MAX_TTL_SECONDS, vodPrefix, vodTokenPath } from "@commonair/contracts/storage";
import { schema, uuidv7 } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { setVodPlacementQueue, vodPlacementDedupeId } from "../src/media/vod-placement-queue.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let owner: User;
let other: User;
let sub: User;
let channelId: string;
const enqueued: string[] = [];
let enqueueFails = false;

beforeAll(async () => {
  api = await startApi();
  setVodPlacementQueue(api.deps, {
    async enqueue(id) {
      if (enqueueFails) throw new Error("valkey down");
      enqueued.push(id);
    },
    async close() {},
  });
  [owner, other, sub] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  channelId = c!.id;
  await db().insert(schema.subscriptions).values({
    subscriberId: sub.userId,
    channelId,
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
type VodOut = { id: string; playlistUrl: string | null; thumbnailUrl: string | null; visibility: string };

async function broadcast(opts: { restricted?: boolean } = {}) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(),
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
    })
    .returning();
  return b!;
}

async function vod(over: Partial<typeof schema.vods.$inferInsert> = {}, at: "public" | "private" = "private") {
  const id = over.id ?? uuidv7();
  const b = over.broadcastId ? null : await broadcast();
  const prefix = vodPrefix(id, at);
  await db()
    .insert(schema.vods)
    .values({
      id,
      channelId,
      broadcastId: b?.id ?? (over.broadcastId as string),
      title: "v",
      storagePrefix: prefix,
      thumbnailKey: `${prefix}thumbnail.webp`,
      status: "ready",
      durationSeconds: 120,
      ...over,
    });
  return id;
}

const get = (who: User | null, id: string) => (who ? who.client : client(api)).call<VodOut>("GET", `/api/vods/${id}`);

const playbackBase = () => api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "");

/** The token of a `/vod/` URL, verified and checked against the VOD. */
async function vodToken(url: string | null, id: string) {
  expect(url).not.toBeNull();
  const u = new URL(url as string);
  expect(`${u.origin}`).toBe(new URL(playbackBase()).origin);
  expect(u.pathname).toBe(`/vod/${id}/index.m3u8`);
  const t = u.searchParams.get("t") as string;
  const v = await verifyPlaybackToken(api.deps.signingKey.publicKey, t, Math.floor(Date.now() / 1000));
  if (!v.ok) throw new Error(`bad token: ${v.error}`);
  expect(v.value).toMatchObject({ path: vodTokenPath(id), src: "origin", cid: channelId });
  return v.value;
}

describe("playlistUrl per audience and visibility", () => {
  test("public under vods/: everyone gets the /media URL", async () => {
    const id = await vod({}, "public");
    for (const who of [null, other, sub, owner]) {
      const r = await get(who, id);
      expect(r.status).toBe(200);
      expect(r.body.playlistUrl).toMatch(new RegExp(`/media/vods/${id}/index\\.m3u8$`));
      expect(r.body.thumbnailUrl).toMatch(new RegExp(`/media/vods/${id}/thumbnail\\.webp$`));
    }
  });

  test("public but still under recordings/ (mid-move): a /vod/ URL, never /media", async () => {
    const id = await vod({}, "private");
    const r = await get(null, id);
    await vodToken(r.body.playlistUrl, id);
    expect(r.body.thumbnailUrl).toMatch(new RegExp(`^${playbackBase()}/vod/${id}/thumbnail\\.webp\\?t=`));
  });

  test("subscribers: the owner and a subscriber get /vod/ URLs; nobody else sees it", async () => {
    // Still under vods/ (before the move): the state alone decides, never the prefix.
    for (const at of ["private", "public"] as const) {
      const id = await vod({ visibility: "subscribers" }, at);
      for (const who of [owner, sub]) {
        const r = await get(who, id);
        expect(r.status).toBe(200);
        await vodToken(r.body.playlistUrl, id);
        expect(r.body.playlistUrl).not.toContain("/media/");
      }
      expect((await get(other, id)).status).toBe(404);
      expect((await get(null, id)).status).toBe(404);
      const list = await client(api).call<{ items: VodOut[] }>("GET", `/api/channels/${owner.username}/vods`);
      expect(list.body.items.map((i) => i.id)).not.toContain(id);
    }
  });

  test("private: only the owner, with a /vod/ URL", async () => {
    const id = await vod({ visibility: "private" });
    await vodToken((await get(owner, id)).body.playlistUrl, id);
    expect((await get(sub, id)).status).toBe(404);
    const listed = await owner.client.call<{ items: VodOut[] }>("GET", `/api/channels/${owner.username}/vods`);
    const item = listed.body.items.find((i) => i.id === id);
    await vodToken(item?.playlistUrl ?? null, id);
  });

  test("not ready, or on a suspended channel: no playable URL (no token is minted)", async () => {
    const processing = await vod({ status: "processing", thumbnailKey: null });
    expect((await get(owner, processing)).body).toMatchObject({ playlistUrl: null, thumbnailUrl: null });
    const id = await vod({ visibility: "private" });
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, channelId));
    try {
      expect((await get(owner, id)).body).toMatchObject({ playlistUrl: null, thumbnailUrl: null });
    } finally {
      await db().update(schema.channels).set({ suspendedAt: null }).where(eq(schema.channels.id, channelId));
    }
  });

  test("the token lives for the duration plus an hour, capped at 12 h", async () => {
    const short = await vod({ visibility: "private", durationSeconds: 100.2 });
    const c = await vodToken((await get(owner, short)).body.playlistUrl, short);
    expect(c.exp - c.iat).toBe(101 + 3600);
    const long = await vod({ visibility: "private", durationSeconds: 20 * 3600 });
    const l = await vodToken((await get(owner, long)).body.playlistUrl, long);
    expect(l.exp - l.iat).toBe(VOD_TOKEN_MAX_TTL_SECONDS);
    // A token for one VOD never names another.
    expect(c.path).not.toBe(l.path);
    expect(c.sid).not.toBe(l.sid);
  });
});

describe("placement enqueues", () => {
  test("a visibility change and a removal enqueue vod-placement after commit; a rename does not", async () => {
    const id = await vod({}, "public");
    enqueued.length = 0;
    expect((await owner.client.call("PATCH", `/api/vods/${id}`, { title: "renamed" })).status).toBe(200);
    expect(enqueued).toEqual([]);
    const r = await owner.client.call<VodOut>("PATCH", `/api/vods/${id}`, { visibility: "subscribers" });
    expect(r.status).toBe(200);
    // Still under vods/ until the worker moves it: the owner's URL is already the token route.
    await vodToken(r.body.playlistUrl, id);
    expect(enqueued).toEqual([id]);
    // The same visibility again changes nothing to move.
    await owner.client.call("PATCH", `/api/vods/${id}`, { visibility: "subscribers" });
    expect(enqueued).toEqual([id]);
    expect((await owner.client.call("DELETE", `/api/vods/${id}`)).status).toBe(200);
    expect(enqueued).toEqual([id, id]);
  });

  test("a failed enqueue never fails the request (the sweep moves it)", async () => {
    const id = await vod({}, "public");
    enqueueFails = true;
    try {
      expect((await owner.client.call("PATCH", `/api/vods/${id}`, { visibility: "private" })).status).toBe(200);
      expect((await owner.client.call("DELETE", `/api/vods/${id}`)).status).toBe(200);
    } finally {
      enqueueFails = false;
    }
    const [row] = await db().select().from(schema.vods).where(eq(schema.vods.id, id));
    expect(row).toMatchObject({ visibility: "private", removedReason: "owner" });
  });

  test("the dedupe id is per VOD and one BullMQ accepts", () => {
    const id = uuidv7();
    expect(vodPlacementDedupeId(id)).toBe(`vod-placement-${id}`);
    expect(vodPlacementDedupeId(id)).not.toContain(":");
  });
});
