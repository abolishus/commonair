// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-content: `vods.recordView` and `clips.recordView` against real Postgres and Valkey. A play
 * counts once per viewer (user, else address) per item per UTC day; only items the caller may
 * play count, anything else is NOT_FOUND; the address lives only as a day-salted hash in a Valkey
 * key that expires at the next UTC midnight.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { utcDay } from "../src/growth/ingest.ts";
import { msToUtcMidnight, recordMediaView, viewKey, viewerHash } from "../src/media-views/record.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

let api: TestApi;
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
let alice: User;
let bob: User;
let carol: User;

beforeAll(async () => {
  api = await startApi({ rateLimits: { playback: { max: 1000, windowMs: 60_000 } } });
  [alice, bob, carol] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

async function channelId(slug: string): Promise<string> {
  const [c] = await db().select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c.id;
}

async function broadcast(cid: string, opts: { mature?: boolean; restricted?: boolean } = {}) {
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({
      channelId: cid,
      ingestProtocol: "rtmp",
      path: `live/${uuidv7()}`,
      startedAt: new Date(Date.now() - 600_000),
      endedAt: new Date(),
      mature: opts.mature ?? false,
      restrictedAt: opts.restricted ? new Date() : null,
      restrictedCaseId: opts.restricted ? uuidv7() : null,
    })
    .returning({ id: schema.broadcasts.id });
  if (!b) throw new Error("no broadcast");
  return b.id;
}

async function vod(cid: string, bid: string, v: Partial<typeof schema.vods.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({ id, channelId: cid, broadcastId: bid, title: "v", storagePrefix: `vods/${id}/`, status: "ready", ...v });
  return id;
}

async function clip(cid: string, bid: string, c: Partial<typeof schema.clips.$inferInsert> = {}) {
  const id = uuidv7();
  await db()
    .insert(schema.clips)
    .values({
      id,
      channelId: cid,
      broadcastId: bid,
      title: "c",
      startOffset: 0,
      durationSeconds: 5,
      status: "ready",
      storageKey: `clips/${id}.mp4`,
      ...c,
    });
  return id;
}

const vodViews = async (id: string) =>
  (await db().select({ n: schema.vods.views }).from(schema.vods).where(eq(schema.vods.id, id)))[0]?.n;
const clipViews = async (id: string) =>
  (await db().select({ n: schema.clips.views }).from(schema.clips).where(eq(schema.clips.id, id)))[0]?.n;

const anon = () => client(api);

describe("vods.recordView", () => {
  test("once per viewer per day: signed in by user, signed out by address", async () => {
    const cid = await channelId(alice.username);
    const id = await vod(cid, await broadcast(cid));
    for (let i = 0; i < 2; i++) {
      const r = await anon().call("POST", `/api/vods/${id}/views`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
    }
    expect(await vodViews(id)).toBe(1);
    for (const u of [bob, carol, bob, carol, alice, alice]) {
      expect((await u.client.call("POST", `/api/vods/${id}/views`)).status).toBe(200);
    }
    // The address (one, here) and three users.
    expect(await vodViews(id)).toBe(4);
  });

  test("a video the caller may not play is NOT_FOUND and never counted", async () => {
    const cid = await channelId(alice.username);
    const bid = await broadcast(cid);
    const priv = await vod(cid, bid, { visibility: "private" });
    const processing = await vod(cid, bid, { status: "processing" });
    const removed = await vod(cid, bid, { removedReason: "owner" });
    const restricted = await vod(cid, await broadcast(cid, { restricted: true }));
    const mature = await vod(cid, await broadcast(cid, { mature: true }));
    for (const id of [priv, processing, removed, restricted, mature]) {
      expect((await anon().call("POST", `/api/vods/${id}/views`)).status).toBe(404);
    }
    for (const id of [priv, processing, removed, restricted]) {
      expect((await bob.client.call("POST", `/api/vods/${id}/views`)).status).toBe(404);
    }
    // The owner may watch their private video (it counts), not one that is still processing.
    expect((await alice.client.call("POST", `/api/vods/${priv}/views`)).status).toBe(200);
    expect((await alice.client.call("POST", `/api/vods/${processing}/views`)).status).toBe(404);
    // A signed-in adult may play the mature one once they confirmed it, as for playback.
    expect((await bob.client.call("POST", `/api/vods/${mature}/views`)).status).toBe(404);
    expect((await bob.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    expect((await bob.client.call("POST", `/api/vods/${mature}/views`)).status).toBe(200);
    expect(await vodViews(priv)).toBe(1);
    expect(await vodViews(mature)).toBe(1);
    for (const id of [processing, removed, restricted]) expect(await vodViews(id)).toBe(0);
    expect((await anon().call("POST", `/api/vods/${uuidv7()}/views`)).status).toBe(404);
  });

  test("a suspended channel's video counts for nobody", async () => {
    const cid = await channelId(carol.username);
    const id = await vod(cid, await broadcast(cid));
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, cid));
    try {
      expect((await anon().call("POST", `/api/vods/${id}/views`)).status).toBe(404);
      expect((await carol.client.call("POST", `/api/vods/${id}/views`)).status).toBe(404);
      expect(await vodViews(id)).toBe(0);
    } finally {
      await db().update(schema.channels).set({ suspendedAt: null }).where(eq(schema.channels.id, cid));
    }
  });
});

describe("clips.recordView", () => {
  test("counts a public clip once per viewer; a clip of a private video is NOT_FOUND to others", async () => {
    const cid = await channelId(bob.username);
    const bid = await broadcast(cid);
    const pub = await clip(cid, bid);
    await anon().call("POST", `/api/clips/${pub}/views`);
    await anon().call("POST", `/api/clips/${pub}/views`);
    await alice.client.call("POST", `/api/clips/${pub}/views`);
    expect(await clipViews(pub)).toBe(2);

    const pbid = await broadcast(cid);
    const pv = await vod(cid, pbid, { visibility: "private" });
    const hidden = await clip(cid, pbid, { vodId: pv });
    expect((await anon().call("POST", `/api/clips/${hidden}/views`)).status).toBe(404);
    expect((await alice.client.call("POST", `/api/clips/${hidden}/views`)).status).toBe(404);
    expect((await bob.client.call("POST", `/api/clips/${hidden}/views`)).status).toBe(200);
    const pending = await clip(cid, bid, { status: "processing" });
    expect((await bob.client.call("POST", `/api/clips/${pending}/views`)).status).toBe(404);
    expect(await clipViews(hidden)).toBe(1);
    expect(await clipViews(pending)).toBe(0);
  });
});

describe("recordMediaView", () => {
  test("addresses dedupe by rate-limit subject; a new UTC day counts again; the key dies at midnight", async () => {
    const cid = await channelId(carol.username);
    const id = await vod(cid, await broadcast(cid));
    const at = new Date("2026-11-11T23:59:00.000Z");
    const deps = { ...api.deps, now: () => at };
    expect(await recordMediaView(deps, "vod", id, { ip: "203.0.113.7" })).toBe(true);
    expect(await recordMediaView(deps, "vod", id, { ip: "203.0.113.7" })).toBe(false);
    expect(await recordMediaView(deps, "vod", id, { ip: "203.0.113.8" })).toBe(true);
    // One IPv6 /64 is one viewer.
    expect(await recordMediaView(deps, "vod", id, { ip: "2001:db8:1:2::1" })).toBe(true);
    expect(await recordMediaView(deps, "vod", id, { ip: "2001:db8:1:2::ffff" })).toBe(false);
    expect(await vodViews(id)).toBe(3);

    const key = await viewKey(api.deps.env.AUTH_SECRET, "vod", id, { ip: "203.0.113.7" }, utcDay(at));
    expect(key).not.toContain("203.0.113.7");
    const ttl = await api.deps.valkey.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);

    const tomorrow = { ...api.deps, now: () => new Date("2026-11-12T00:01:00.000Z") };
    expect(await recordMediaView(tomorrow, "vod", id, { ip: "203.0.113.7" })).toBe(true);
    expect(await vodViews(id)).toBe(4);
    await api.deps.valkey.del(key);
  });

  test("the hash changes with the day and differs between a user and an address", async () => {
    const s = api.deps.env.AUTH_SECRET;
    const a = await viewerHash(s, { ip: "198.51.100.1" }, "2026-11-11");
    expect(await viewerHash(s, { ip: "198.51.100.1" }, "2026-11-11")).toBe(a);
    expect(await viewerHash(s, { ip: "198.51.100.1" }, "2026-11-12")).not.toBe(a);
    expect(await viewerHash(s, { userId: "198.51.100.1" }, "2026-11-11")).not.toBe(a);
  });

  test("updated_at is left alone", async () => {
    const cid = await channelId(carol.username);
    const before = new Date("2026-01-01T00:00:00.000Z");
    const id = await vod(cid, await broadcast(cid), { updatedAt: before });
    expect(await recordMediaView(api.deps, "vod", id, { userId: uuidv7() })).toBe(true);
    const [row] = await db().select().from(schema.vods).where(eq(schema.vods.id, id));
    expect(row?.views).toBe(1);
    expect(row?.updatedAt.toISOString()).toBe(before.toISOString());
  });
});

describe("msToUtcMidnight", () => {
  test("counts to the next UTC midnight, never zero", () => {
    expect(msToUtcMidnight(new Date("2026-11-11T00:00:00.000Z"))).toBe(86_400_000);
    expect(msToUtcMidnight(new Date("2026-11-11T23:59:59.999Z"))).toBe(1);
    expect(msToUtcMidnight(new Date("2026-11-11T12:00:00.000Z"))).toBe(43_200_000);
  });
});
