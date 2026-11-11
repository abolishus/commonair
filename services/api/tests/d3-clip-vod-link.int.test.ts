// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `Clip.vodId` / `Clip.vodOffsetSeconds` (overhaul wave 2, D3.9 "Watch from this moment"): the
 * video of the clip's broadcast when the caller may watch it, and the clip's start offset into it.
 * Null when there is no such video, it is not ready, the caller may not see it (private,
 * restricted, removed, 18+ not confirmed) or the clip starts past its end.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
type Link = { id: string; vodId: string | null; vodOffsetSeconds: number | null };
type Page = { items: Link[]; nextCursor: string | null };

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function broadcast(channelId: string, opts: { restricted?: boolean; mature?: boolean } = {}) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 3600_000),
      endedAt: new Date(),
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
      durationSeconds: 1800,
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
      startOffset: 754.5,
      durationSeconds: 30,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
      ...c,
    });
  return id;
}

const anon = async (id: string) => (await client(api).call<Link>("GET", `/api/clips/${id}`)).body;

describe("clip -> video link", () => {
  test("a clip cut live links to its broadcast's ready public video at the clip's start", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id);
    const v = await vod(c.id, b.id);
    const k = await clip(c.id, b.id);
    expect(await anon(k)).toMatchObject({ vodId: v, vodOffsetSeconds: 754.5 });
    // The listing carries it too.
    const listed = await client(api).call<Page>("GET", `/api/channels/${owner.username}/clips`);
    expect(listed.body.items.find((x) => x.id === k)).toMatchObject({ vodId: v, vodOffsetSeconds: 754.5 });
  });

  test("a clip cut from a video links to that video", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id);
    const v = await vod(c.id, b.id);
    const k = await clip(c.id, b.id, { vodId: v, startOffset: 60 });
    expect(await anon(k)).toMatchObject({ vodId: v, vodOffsetSeconds: 60 });
  });

  test("no video, a video still processing, or a clip past its end: both null", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const none = await broadcast(c.id);
    const k1 = await clip(c.id, none.id);
    const processing = await broadcast(c.id);
    await vod(c.id, processing.id, { status: "processing" });
    const k2 = await clip(c.id, processing.id);
    const short = await broadcast(c.id);
    await vod(c.id, short.id, { durationSeconds: 600 });
    const k3 = await clip(c.id, short.id, { startOffset: 600 });
    for (const k of [k1, k2, k3]) expect(await anon(k)).toMatchObject({ vodId: null, vodOffsetSeconds: null });
  });

  test("a private video links for the owner only", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id);
    const v = await vod(c.id, b.id, { visibility: "private" });
    // Clips follow their source's visibility (`clipVisible`): the public cannot read this one at all.
    const k = await clip(c.id, b.id);
    expect((await client(api).call("GET", `/api/clips/${k}`)).status).toBe(404);
    const own = await owner.client.call<Link>("GET", `/api/clips/${k}`);
    expect(own.body).toMatchObject({ vodId: v, vodOffsetSeconds: 754.5 });
    const other = await signUpAndSignIn(api);
    expect((await other.client.call("GET", `/api/clips/${k}`)).status).toBe(404);
  });

  test("a subscriber-only video links for subscribers (and the owner), not for other members", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const sub = await signUpAndSignIn(api);
    await db().insert(schema.subscriptions).values({
      subscriberId: sub.userId,
      channelId: c.id,
      tier: 1,
      status: "active",
      provider: "manual",
      priceCents: 500,
      currency: "usd",
    });
    const b = await broadcast(c.id);
    const v = await vod(c.id, b.id, { visibility: "subscribers" });
    const k = await clip(c.id, b.id);
    expect((await sub.client.call<Link>("GET", `/api/clips/${k}`)).body).toMatchObject({ vodId: v });
    expect((await owner.client.call<Link>("GET", `/api/clips/${k}`)).body).toMatchObject({ vodId: v });
    const other = await signUpAndSignIn(api);
    expect((await other.client.call("GET", `/api/clips/${k}`)).status).toBe(404);
  });

  test("a video removed by its owner is never offered (and hides the clip)", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id);
    await vod(c.id, b.id, { removedReason: "owner", status: "deleted" });
    const k = await clip(c.id, b.id);
    expect((await owner.client.call("GET", `/api/clips/${k}`)).status).toBe(404);
  });

  test("18+: the link goes with the URLs, to the owner and confirmed adults only", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const b = await broadcast(c.id, { mature: true });
    const v = await vod(c.id, b.id);
    const k = await clip(c.id, b.id);
    expect(await anon(k)).toMatchObject({ url: null, vodId: null, vodOffsetSeconds: null });
    expect((await owner.client.call<Link>("GET", `/api/clips/${k}`)).body).toMatchObject({ vodId: v });
    const adult = await signUpAndSignIn(api);
    expect((await adult.client.call<Link>("GET", `/api/clips/${k}`)).body.vodId).toBeNull();
    expect((await adult.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    expect((await adult.client.call<Link>("GET", `/api/clips/${k}`)).body).toMatchObject({
      vodId: v,
      vodOffsetSeconds: 754.5,
    });
  });
});
