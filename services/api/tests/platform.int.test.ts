// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BUS } from "@commonair/contracts/events";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, MEDIA_INTERNAL_USER, mediaPath } from "@commonair/contracts/internal";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import { insertBotAccount } from "../src/auth/bot-account.ts";
import { client, signUpAndSignIn, startApi, subscriber, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let alice: Awaited<ReturnType<typeof signUpAndSignIn>>;
let bob: Awaited<ReturnType<typeof signUpAndSignIn>>;

beforeAll(async () => {
  api = await startApi();
  alice = await signUpAndSignIn(api);
  bob = await signUpAndSignIn(api);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const channelOf = async (slug: string) => {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
};
const eventsOf = (channelId: string, type: string) =>
  db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)));

const mediaAuth = (body: Record<string, unknown>) =>
  fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ip: "10.0.0.5", protocol: "rtmp", ...body }),
  });
const hook = (route: string, body: Record<string, unknown>, secret = api.internalSecret) =>
  fetch(`${api.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
    body: JSON.stringify(body),
  });

async function rotate(c: Client, slug: string) {
  const r = await c.call<{ key: string; prefix: string }>("POST", `/api/channels/${slug}/stream-keys`);
  expect(r.status).toBe(200);
  const secret = r.body.key.split("?key=")[1];
  if (!secret) throw new Error("bad key format");
  return { ...r.body, secret };
}

async function goLive(slug: string, sourceId = crypto.randomUUID()) {
  const res = await hook(INTERNAL_ROUTES.mediaReady, { path: mediaPath(slug), sourceType: "rtmpConn", sourceId });
  expect(res.status).toBe(204);
  return sourceId;
}

describe("follows", () => {
  test("follow/unfollow keeps followerCount and writes the outbox", async () => {
    const c = await channelOf(alice.username);
    const f = await bob.client.call<{ following: boolean; followerCount: number }>(
      "PUT",
      `/api/channels/${alice.username}/follow`,
      {},
    );
    expect(f.status).toBe(200);
    expect(f.body).toEqual({ following: true, followerCount: 1 });
    // Following twice is idempotent: no second event, no double count.
    const again = await bob.client.call<{ followerCount: number }>("PUT", `/api/channels/${alice.username}/follow`, {
      notify: false,
    });
    expect(again.body.followerCount).toBe(1);
    const evs = await eventsOf(c.id, "channel.follow");
    expect(evs).toHaveLength(1);
    expect(evs[0]?.payload).toMatchObject({ broadcaster_user_login: alice.username, user_login: bob.username });
    const mine = await bob.client.call<{ items: { channel: { slug: string }; notify: boolean }[] }>(
      "GET",
      "/api/me/follows",
    );
    expect(mine.body.items.map((i) => i.channel.slug)).toContain(alice.username);
    expect(mine.body.items[0]?.notify).toBe(false);
    const followers = await alice.client.call<{ items: { user: { username: string } }[] }>(
      "GET",
      `/api/channels/${alice.username}/followers`,
    );
    expect(followers.body.items.map((i) => i.user.username)).toEqual([bob.username]);
    // Followers are owner-only.
    expect((await bob.client.call("GET", `/api/channels/${alice.username}/followers`)).status).toBe(403);

    const un = await bob.client.call<{ following: boolean; followerCount: number }>(
      "DELETE",
      `/api/channels/${alice.username}/follow`,
    );
    expect(un.body).toEqual({ following: false, followerCount: 0 });
    expect((await channelOf(alice.username)).followerCount).toBe(0);
  });

  test("channels.get reports the caller's follow state (null when anonymous)", async () => {
    type Ch = { viewer?: { following: boolean } | null };
    const get = (c: ReturnType<typeof client>) => c.call<Ch>("GET", `/api/channels/${alice.username}`);
    expect((await get(client(api))).body.viewer).toBeNull();
    expect((await get(bob.client)).body.viewer).toEqual({ following: false });
    await bob.client.call("PUT", `/api/channels/${alice.username}/follow`, {});
    expect((await get(bob.client)).body.viewer).toEqual({ following: true });
    await bob.client.call("DELETE", `/api/channels/${alice.username}/follow`);
    expect((await get(bob.client)).body.viewer).toEqual({ following: false });
  });

  test("cannot follow yourself; anonymous cannot follow", async () => {
    expect((await alice.client.call("PUT", `/api/channels/${alice.username}/follow`, {})).status).toBe(400);
    expect((await client(api).call("PUT", `/api/channels/${alice.username}/follow`, {})).status).toBe(401);
  });
});

describe("stream keys and MediaMTX auth", () => {
  test("rotate → publish accepted with the new key, refused with the old", async () => {
    const first = await rotate(alice.client, alice.username);
    expect(first.key).toBe(`${alice.username}?key=${first.secret}`);
    expect(first.prefix).toBe(first.secret.slice(0, 12));
    const path = mediaPath(alice.username);
    expect((await mediaAuth({ action: "publish", path, query: `key=${first.secret}` })).status).toBe(200);
    const second = await rotate(alice.client, alice.username);
    expect((await mediaAuth({ action: "publish", path, query: `key=${first.secret}` })).status).toBe(401);
    expect((await mediaAuth({ action: "publish", path, query: `key=${second.secret}` })).status).toBe(200);
    // WHIP presents the key as a bearer token.
    expect((await mediaAuth({ action: "publish", path, protocol: "webrtc", token: second.secret })).status).toBe(200);
    // A key for one channel never publishes another.
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(bob.username), query: `key=${second.secret}` })).status,
    ).toBe(401);
    const keys = await alice.client.call<{ revokedAt: string | null; revokedReason: string | null }[]>(
      "GET",
      `/api/channels/${alice.username}/stream-keys`,
    );
    expect(keys.body.filter((k) => k.revokedAt === null)).toHaveLength(1);
    expect(keys.body.some((k) => k.revokedReason === "rotated")).toBe(true);
    // The full key is never listed.
    expect(JSON.stringify(keys.body)).not.toContain(second.secret);
    // Only the owner manages keys.
    expect((await bob.client.call("POST", `/api/channels/${alice.username}/stream-keys`)).status).toBe(403);
  });

  test("read, api and metrics need internal credentials; everything else is refused", async () => {
    const path = mediaPath(alice.username);
    expect((await mediaAuth({ action: "read", path, protocol: "rtsp" })).status).toBe(401);
    expect(
      (
        await mediaAuth({
          action: "read",
          path,
          protocol: "rtsp",
          user: MEDIA_INTERNAL_USER,
          password: api.mediaPassword,
        })
      ).status,
    ).toBe(200);
    // The service-to-service secret is not a MediaMTX credential.
    const as = (password: string, extra: Record<string, unknown>) =>
      mediaAuth({ user: MEDIA_INTERNAL_USER, password, ...extra }).then((r) => r.status);
    expect(await as(api.internalSecret, { action: "read", path, protocol: "rtsp" })).toBe(401);
    expect(await as(api.mediaPassword, { action: "api", path: "", protocol: "" })).toBe(200);
    // Renditions are published only by the media service.
    expect(await as(api.mediaPassword, { action: "publish", path: `${path}/720p`, protocol: "rtsp" })).toBe(200);
    expect(await as("nope", { action: "publish", path: `${path}/720p`, protocol: "rtsp" })).toBe(401);
    expect(
      (await mediaAuth({ action: "api", path: "", protocol: "hls", user: MEDIA_INTERNAL_USER, password: "nope" }))
        .status,
    ).toBe(401);
    expect(
      (
        await mediaAuth({
          action: "pprof",
          path: "",
          protocol: "hls",
          user: MEDIA_INTERNAL_USER,
          password: api.mediaPassword,
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${api.url}${INTERNAL_ROUTES.mediaAuth}`, { method: "POST", body: "not json" })).status).toBe(
      401,
    );
  });

  test("suspended channels cannot publish", async () => {
    const k = await rotate(bob.client, bob.username);
    const c = await channelOf(bob.username);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.id, c.id));
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(bob.username), query: `key=${k.secret}` })).status,
    ).toBe(401);
    await db().update(schema.channels).set({ suspendedAt: null }).where(eq(schema.channels.id, c.id));
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(bob.username), query: `key=${k.secret}` })).status,
    ).toBe(200);
  });

  test("a leaked key in a panel is revoked and the owner notified", async () => {
    const k = await rotate(alice.client, alice.username);
    const res = await alice.client.call<{ body: string }[]>("PUT", `/api/channels/${alice.username}/panels`, {
      panels: [{ title: "About", body: `oops my key: ${k.secret}`, imageKey: null, linkUrl: null }],
    });
    expect(res.status).toBe(200);
    expect(res.body[0]?.body).not.toContain(k.secret);
    expect(
      (await mediaAuth({ action: "publish", path: mediaPath(alice.username), query: `key=${k.secret}` })).status,
    ).toBe(401);
    const notes = await alice.client.call<{ items: { payload: Record<string, unknown> }[] }>(
      "GET",
      "/api/me/notifications",
    );
    expect(notes.body.items.some((n) => n.payload.kind === "stream_key_leaked")).toBe(true);
    const audit = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "stream_key.revoke_leaked"));
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe("live lifecycle, playback and discovery", () => {
  test("mediaReady/notReady: broadcast row, events, BUS.live; idempotent", async () => {
    const sub = subscriber();
    const live: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.live);
    sub.on("message", (_ch, msg) => live.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      const k = await rotate(alice.client, alice.username);
      expect(
        (await mediaAuth({ action: "publish", path: mediaPath(alice.username), query: `key=${k.secret}` })).status,
      ).toBe(200);
      // Hooks need the internal secret.
      expect(
        (await hook(INTERNAL_ROUTES.mediaReady, { path: mediaPath(alice.username), sourceType: "rtmpConn" }, "wrong"))
          .status,
      ).toBe(401);
      const sourceId = await goLive(alice.username);
      await goLive(alice.username, sourceId); // duplicate
      const c = await channelOf(alice.username);
      expect(c.liveBroadcastId).not.toBeNull();
      const bs = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, c.id));
      expect(bs).toHaveLength(1);
      expect(bs[0]).toMatchObject({ ingestProtocol: "rtmp", path: mediaPath(alice.username), endedAt: null });
      expect(bs[0]?.streamKeyId).not.toBeNull();
      const [key] = await db()
        .select()
        .from(schema.streamKeys)
        .where(eq(schema.streamKeys.id, bs[0]?.streamKeyId ?? ""));
      expect(key?.lastUsedAt).not.toBeNull();
      expect(await eventsOf(c.id, "stream.online")).toHaveLength(1);
      const pub = await client(api).call<{ live: { id: string } | null }>("GET", `/api/channels/${alice.username}`);
      expect(pub.body.live?.id).toBe(bs[0]?.id);

      await hook(INTERNAL_ROUTES.mediaNotReady, { path: mediaPath(alice.username), sourceType: "rtmpConn", sourceId });
      await hook(INTERNAL_ROUTES.mediaNotReady, { path: mediaPath(alice.username), sourceType: "rtmpConn", sourceId });
      // A late "ready" for the same, already-ended source is ignored.
      await goLive(alice.username, sourceId);
      const after = await channelOf(alice.username);
      expect(after.liveBroadcastId).toBeNull();
      const [ended] = await db().select().from(schema.broadcasts).where(eq(schema.broadcasts.channelId, c.id));
      expect(ended?.endedAt).not.toBeNull();
      expect(await eventsOf(c.id, "stream.offline")).toHaveLength(1);
      await Bun.sleep(200);
      const mine = live.filter((e) => e.channelId === c.id).map((e) => e.type);
      expect(mine).toEqual(["online", "offline"]);
    } finally {
      sub.disconnect();
    }
  });

  test("playback start → heartbeats → verified viewer count", async () => {
    await goLive(alice.username);
    const c = await channelOf(alice.username);
    let clock = Date.now();
    const realNow = api.deps.now;
    api.deps.now = () => new Date(clock);
    try {
      const viewer = client(api);
      const start = await viewer.call<{
        sessionId: string;
        token: string;
        playlistUrl: string;
        source: string;
        p2p: { enabled: boolean };
      }>("POST", `/api/channels/${alice.username}/playback`, { deviceId: "device-0123456789abcdef", nativeHls: true });
      expect(start.status).toBe(200);
      expect(start.body.source).toBe("origin");
      expect(start.body.p2p.enabled).toBe(false);
      expect(start.body.playlistUrl).toContain(`/hls/${mediaPath(alice.username)}/index.m3u8?t=`);
      const [row] = await db()
        .select()
        .from(schema.playbackSessions)
        .where(eq(schema.playbackSessions.id, start.body.sessionId));
      expect(row?.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.deviceHash).not.toContain("device-0123456789abcdef");

      const beat = (token = start.body.token, over: Record<string, unknown> = {}) =>
        viewer.call<{ ok: true; token?: string }>("POST", "/api/playback/heartbeat", {
          sessionId: start.body.sessionId,
          token,
          playedSeconds: 10,
          bufferSeconds: 3,
          stalls: 0,
          bytesHttp: 1000,
          bytesP2p: 0,
          rendition: "source",
          latencySeconds: 2,
          ttffMs: 800,
          visible: true,
          muted: false,
          ...over,
        });
      const pub = async () =>
        (await client(api).call<{ live: { viewerCount: number } | null }>("GET", `/api/channels/${alice.username}`))
          .body.live?.viewerCount;
      for (let i = 0; i < 2; i++) {
        clock += 10_000;
        expect((await beat()).status).toBe(200);
      }
      await api.deps.valkey.del(`viewer-count:${c.id}`);
      expect(await pub()).toBe(0);
      clock += 10_000;
      expect((await beat()).status).toBe(200);
      expect(await pub()).toBe(1);
      const [verified] = await db()
        .select()
        .from(schema.playbackSessions)
        .where(eq(schema.playbackSessions.id, start.body.sessionId));
      expect(verified).toMatchObject({ verdict: "verified", heartbeats: 3, watchSeconds: 30, bytesHttp: 3000 });

      // Tokens are refreshed before they expire.
      clock += 70_000;
      const refreshed = await beat(start.body.token, { playedSeconds: 70 });
      expect(refreshed.body.token).toBeDefined();
      // A token for another session is refused.
      expect((await beat("garbage.token")).status).toBe(401);

      // Health shows verified viewers to the owner.
      const health = await alice.client.call<{ live: boolean; viewers: { verified: number } }>(
        "GET",
        `/api/channels/${alice.username}/health`,
      );
      expect(health.body).toMatchObject({ live: true, viewers: { verified: 1 } });

      expect(
        (
          await viewer.call("POST", "/api/playback/end", {
            sessionId: start.body.sessionId,
            token: refreshed.body.token,
          })
        ).status,
      ).toBe(200);
      expect((await beat(refreshed.body.token)).status).toBe(409);
    } finally {
      api.deps.now = realNow;
    }
  });

  test("offline channels cannot start playback", async () => {
    const r = await client(api).call("POST", `/api/channels/${bob.username}/playback`, {
      deviceId: "device-0123456789abcdef",
    });
    expect(r.status).toBe(412);
  });

  test("directory shows live channels with reasons; search finds channels", async () => {
    const home = await client(api).call<{
      spotlight: { channel: { slug: string }; reason: string }[];
      live: { channel: { slug: string }; reason: string }[];
      newAndLive: { reason: string }[];
      rankingVersion: string;
    }>("GET", "/api/directory");
    expect(home.status).toBe(200);
    expect(home.body.live.map((c) => c.channel.slug)).toContain(alice.username);
    expect(home.body.live.every((c) => c.reason === "popular")).toBe(true);
    expect(home.body.spotlight.map((c) => c.channel.slug)).toContain(alice.username);
    expect(home.body.newAndLive.every((c) => c.reason === "new")).toBe(true);
    // Followers see the channel under "following".
    await bob.client.call("PUT", `/api/channels/${alice.username}/follow`, {});
    const bobs = await bob.client.call<{ following: { channel: { slug: string } }[] }>("GET", "/api/directory");
    expect(bobs.body.following.map((c) => c.channel.slug)).toEqual([alice.username]);
    const random = await client(api).call<{ reason: string } | null>("GET", "/api/directory/random");
    expect(random.body?.reason).toBe("random");
    const ranking = await client(api).call<{ explanation: string; config: { spotlightSlots: number } }>(
      "GET",
      "/api/directory/ranking",
    );
    expect(ranking.body.config.spotlightSlots).toBeGreaterThan(0);
    expect(ranking.body.explanation).toContain("verified");
    const found = await client(api).call<{ channels: { slug: string }[] }>("GET", `/api/search?q=${alice.username}`);
    expect(found.body.channels.map((c) => c.slug)).toContain(alice.username);
  });

  test("mature streams are hidden unless includeMature and a confirmed adult", async () => {
    await alice.client.call("PATCH", `/api/channels/${alice.username}`, { mature: true });
    const anon = await client(api).call<{ live: { channel: { slug: string } }[] }>(
      "GET",
      "/api/directory?includeMature=true",
    );
    expect(anon.body.live.map((c) => c.channel.slug)).not.toContain(alice.username);
    expect((await bob.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    const adult = await bob.client.call<{ live: { channel: { slug: string } }[] }>(
      "GET",
      "/api/directory?includeMature=true",
    );
    expect(adult.body.live.map((c) => c.channel.slug)).toContain(alice.username);
    const notAsked = await bob.client.call<{ live: { channel: { slug: string } }[] }>("GET", "/api/directory");
    expect(notAsked.body.live.map((c) => c.channel.slug)).not.toContain(alice.username);
    await alice.client.call("PATCH", `/api/channels/${alice.username}`, { mature: false });
  });
});

describe("offline channels on the front page", () => {
  type Card = { channel: { slug: string }; title: string; lastLiveAt: string | null; mature: boolean };
  type Home = { recentlyLive: Card[]; followingOffline: Card[] };
  const slugs = (cards: Card[], only: string[]) => cards.map((c) => c.channel.slug).filter((s) => only.includes(s));

  test("recentlyLive orders by last broadcast; followingOffline keeps never-live follows; mature hidden", async () => {
    const carol = await signUpAndSignIn(api);
    const dave = await signUpAndSignIn(api);
    const erin = await signUpAndSignIn(api);
    const mine = [carol.username, dave.username, erin.username, alice.username];
    const now = Date.now();
    const ended = async (slug: string, title: string, endedHoursAgo: number) => {
      const c = await channelOf(slug);
      await db()
        .insert(schema.broadcasts)
        .values({
          channelId: c.id,
          ingestProtocol: "rtmp",
          path: mediaPath(slug),
          title,
          startedAt: new Date(now - (endedHoursAgo + 1) * 3_600_000),
          endedAt: new Date(now - endedHoursAgo * 3_600_000),
        });
    };
    await ended(carol.username, "older show", 5);
    await ended(carol.username, "latest show", 1);
    await ended(dave.username, "dave show", 2);
    // alice is still live from the playback test (and has an ended broadcast from the lifecycle test).
    expect((await channelOf(alice.username)).liveBroadcastId).not.toBeNull();

    const anon = await client(api).call<Home>("GET", "/api/directory");
    expect(anon.status).toBe(200);
    // Live channels and channels that never broadcast are not "recently live".
    expect(slugs(anon.body.recentlyLive, mine)).toEqual([carol.username, dave.username]);
    const card = anon.body.recentlyLive.find((c) => c.channel.slug === carol.username);
    expect(card?.title).toBe("latest show");
    expect(card?.lastLiveAt).not.toBeNull();
    expect(anon.body.followingOffline).toEqual([]);

    await bob.client.call("PUT", `/api/channels/${erin.username}/follow`, {});
    await bob.client.call("PUT", `/api/channels/${carol.username}/follow`, {});
    await bob.client.call("PUT", `/api/channels/${alice.username}/follow`, {});
    const bobs = await bob.client.call<Home>("GET", "/api/directory");
    // Live alice is in `following`, not here; never-live erin sorts last.
    expect(slugs(bobs.body.followingOffline, mine)).toEqual([carol.username, erin.username]);
    expect(bobs.body.followingOffline.find((c) => c.channel.slug === erin.username)?.lastLiveAt).toBeNull();

    await carol.client.call("PATCH", `/api/channels/${carol.username}`, { mature: true });
    const hidden = await client(api).call<Home>("GET", "/api/directory?includeMature=true");
    expect(slugs(hidden.body.recentlyLive, mine)).toEqual([dave.username]);
    // bob confirmed adulthood in the mature test above.
    const shown = await bob.client.call<Home>("GET", "/api/directory?includeMature=true");
    expect(shown.body.recentlyLive.find((c) => c.channel.slug === carol.username)?.mature).toBe(true);
  });
});

describe("chat moderation", () => {
  test("ban writes chat_bans, mod_actions, audit_log, outbox and publishes chatControl", async () => {
    const c = await channelOf(alice.username);
    const sub = subscriber();
    const frames: Record<string, unknown>[] = [];
    await sub.subscribe(BUS.chatControl(c.id));
    sub.on("message", (_ch, msg) => frames.push(JSON.parse(msg) as Record<string, unknown>));
    try {
      const ban = await alice.client.call<{ user: { username: string }; expiresAt: string | null }>(
        "POST",
        `/api/channels/${alice.username}/bans`,
        { username: bob.username, reason: "spam", durationSeconds: 600 },
      );
      expect(ban.status).toBe(200);
      expect(ban.body.user.username).toBe(bob.username);
      expect(ban.body.expiresAt).not.toBeNull();
      const audit = await db()
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.channelId, c.id), eq(schema.auditLog.action, "chat.timeout")));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: alice.userId, subjectId: bob.userId, reason: "spam" });
      const mods = await db().select().from(schema.modActions).where(eq(schema.modActions.channelId, c.id));
      expect(mods.map((m) => m.action)).toContain("timeout");
      expect(await eventsOf(c.id, "channel.ban")).toHaveLength(1);
      const list = await alice.client.call<{ items: unknown[] }>("GET", `/api/channels/${alice.username}/bans`);
      expect(list.body.items).toHaveLength(1);
      // Bob cannot moderate, and nobody can ban the broadcaster.
      expect(
        (await bob.client.call("POST", `/api/channels/${alice.username}/bans`, { username: alice.username })).status,
      ).toBe(403);
      const unban = await alice.client.call("DELETE", `/api/channels/${alice.username}/bans/${bob.username}`);
      expect(unban.status).toBe(200);
      expect(await eventsOf(c.id, "channel.unban")).toHaveLength(1);
      expect((await alice.client.call("DELETE", `/api/channels/${alice.username}/bans/${bob.username}`)).status).toBe(
        404,
      );
      const settings = await alice.client.call<{ slowModeSeconds: number }>(
        "PATCH",
        `/api/channels/${alice.username}/chat/settings`,
        {
          slowModeSeconds: 5,
        },
      );
      expect(settings.body.slowModeSeconds).toBe(5);
      expect(await eventsOf(c.id, "channel.chat_settings.update")).toHaveLength(1);
      await Bun.sleep(200);
      expect(frames.map((f) => f.op)).toEqual(["ban", "invalidate", "settings"]);
      expect(frames[0]).toMatchObject({ userId: bob.userId, reason: "spam" });
    } finally {
      sub.disconnect();
    }
  });

  test("moderators can ban viewers but not other moderators", async () => {
    const carol = await signUpAndSignIn(api);
    expect(
      (await alice.client.call("PUT", `/api/channels/${alice.username}/roles/${bob.username}`, { role: "moderator" }))
        .status,
    ).toBe(200);
    expect(
      (await alice.client.call("PUT", `/api/channels/${alice.username}/roles/${carol.username}`, { role: "moderator" }))
        .status,
    ).toBe(200);
    expect(
      (await bob.client.call("POST", `/api/channels/${alice.username}/bans`, { username: carol.username })).status,
    ).toBe(403);
    await alice.client.call("DELETE", `/api/channels/${alice.username}/roles/${carol.username}`, { role: "moderator" });
    expect(
      (await bob.client.call("POST", `/api/channels/${alice.username}/bans`, { username: carol.username })).status,
    ).toBe(200);
    const roles = await bob.client.call<{ role: string }[]>("GET", `/api/channels/${alice.username}/roles`);
    expect(roles.body.map((r) => r.role)).toEqual(["moderator"]);
  });

  test("chat connect tokens: anonymous read-only, members full", async () => {
    const anon = await client(api).call<{ token: string; url: string }>("POST", "/api/chat/token");
    expect(anon.status).toBe(200);
    const { verifyChatToken } = await import("@commonair/tokens");
    const a = await verifyChatToken(api.internalSecret, anon.body.token);
    expect(a).toMatchObject({ uid: null, scopes: ["chat:read"] });
    const member = await bob.client.call<{ token: string }>("POST", "/api/chat/token");
    const m = await verifyChatToken(api.internalSecret, member.body.token);
    expect(m?.uid).toBe(bob.userId);
    expect(m?.scopes).toContain("chat:edit");
  });
});

describe("tokens, bots and the API surface", () => {
  test("bot token with insufficient scope is refused", async () => {
    const bot = await alice.client.call<{ id: string; accountType: string; botOwner: { username: string } }>(
      "POST",
      "/api/me/bots",
      {
        username: `${alice.username.slice(0, 18)}_bot`,
        displayName: "Alice Bot",
      },
    );
    expect(bot.status).toBe(200);
    expect(bot.body).toMatchObject({ accountType: "bot", botOwner: { username: alice.username } });
    const minted = await alice.client.call<{ accessToken: string }>("POST", `/api/me/bots/${bot.body.id}/tokens`, {
      scopes: ["chat:read"],
    });
    expect(minted.status).toBe(200);
    // tmi.js lowercases the PASS it sends: the token must already be lowercase to sign in over IRC.
    expect(minted.body.accessToken).toBe(minted.body.accessToken.toLowerCase());
    const asBot = client(api, { bearer: minted.body.accessToken });
    expect((await asBot.call("GET", "/api/me")).status).toBe(403); // needs user:read:email
    expect((await asBot.call("GET", "/api/me/follows")).status).toBe(403); // needs user:read:follows
    expect((await asBot.call("GET", "/api/me/bots")).status).toBe(403); // session only
    const validate = await asBot.call<{ login: string; scopes: string[]; expires_in: number }>(
      "GET",
      "/api/oauth2/validate",
    );
    expect(validate.status).toBe(200);
    expect(validate.body.scopes).toEqual(["chat:read"]);
    expect(validate.body.expires_in).toBeGreaterThan(0);
    const broader = await alice.client.call<{ accessToken: string }>("POST", `/api/me/bots/${bot.body.id}/tokens`, {
      scopes: ["user:read:follows", "user:read:email"],
    });
    const asBot2 = client(api, { bearer: broader.body.accessToken });
    expect((await asBot2.call("GET", "/api/me/follows")).status).toBe(200);
    expect((await asBot2.call("GET", "/api/me")).status).toBe(200);
    expect((await client(api, { bearer: "ca_not-a-token" }).call("GET", "/api/me")).status).toBe(401);
    // Someone else's bot cannot be given tokens.
    expect(
      (await bob.client.call("POST", `/api/me/bots/${bot.body.id}/tokens`, { scopes: ["chat:read"] })).status,
    ).toBe(404);
  });

  test("the channel bot takes no bot slot and cannot have tokens (E8)", async () => {
    const carol = await signUpAndSignIn(api);
    const channel = await channelOf(carol.username);
    const channelBot = await insertBotAccount(db(), {
      ownerId: channel.ownerId,
      username: `${carol.username.slice(0, 18)}_bot`,
      displayName: "Carol's channel bot",
    });
    await db()
      .insert(schema.botConfigs)
      .values({ channelId: channel.id, config: BotConfig.parse({}), botUserId: channelBot.id });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await carol.client.call<{ id: string }>("POST", "/api/me/bots", {
        username: `${carol.username.slice(0, 18)}_b${i}`,
        displayName: `Bot ${i}`,
      });
      expect(r.status, `bot ${i}`).toBe(200);
      ids.push(r.body.id);
    }
    const eleventh = await carol.client.call<{ data: { requirement: string } }>("POST", "/api/me/bots", {
      username: `${carol.username.slice(0, 18)}_bx`,
      displayName: "One too many",
    });
    expect(eleventh.status).toBe(412);
    expect(eleventh.body.data.requirement).toBe("bot_limit");
    const listed = await carol.client.call<{ id: string }[]>("GET", "/api/me/bots");
    expect(listed.status).toBe(200);
    expect(listed.body.map((b) => b.id).toSorted()).toEqual(ids.toSorted());

    const refused = await carol.client.call<{ code: string; data: { requirement: string } }>(
      "POST",
      `/api/me/bots/${channelBot.id}/tokens`,
      { scopes: ["chat:read"] },
    );
    expect(refused.status).toBe(412);
    expect(refused.body).toMatchObject({ code: "PRECONDITION_FAILED", data: { requirement: "channel_bot" } });
    expect(await db().select().from(schema.oauthTokens).where(eq(schema.oauthTokens.userId, channelBot.id))).toEqual(
      [],
    );
    const ordinary = await carol.client.call("POST", `/api/me/bots/${ids[0]}/tokens`, { scopes: ["chat:read"] });
    expect(ordinary.status).toBe(200);
  });

  test("OpenAPI document, instance info and status", async () => {
    const doc = await fetch(`${api.url}/api/openapi.json`);
    expect(doc.status).toBe(200);
    const json = (await doc.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(json.openapi).toMatch(/^3\.1/);
    expect(Object.keys(json.paths)).toContain("/channels/{channel}/follow");
    const info = await client(api).call<{ sourceUrl: string; minAge: number; features: { payments: string } }>(
      "GET",
      "/api/instance",
    );
    // W1: the verified-watch gate and the surge guard are off unless the operator turns them on.
    expect(info.body).toMatchObject({
      minAge: 13,
      features: { payments: "manual", watchGate: false, surgeGuard: false },
    });
    const status = await client(api).call<{ status: string; components: { id: string; status: string }[] }>(
      "GET",
      "/api/status",
    );
    expect(status.body.components.map((c) => c.id).sort()).toEqual(["postgres", "valkey"]);
    expect(status.body.status).toBe("operational");
  });

  test("unbuilt procedures answer 501 NOT_IMPLEMENTED", async () => {
    const r = await alice.client.call<{ code: string }>("GET", `/api/channels/${alice.username}/integrity`);
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("NOT_IMPLEMENTED");
    // Same procedure over the RPC transport (oRPC wraps the input in `json`).
    const rpc = await fetch(`${api.url}/rpc/integrity/channelSummary`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        cookie: alice.client.jar.header(),
      },
      body: JSON.stringify({ json: { channel: alice.username } }),
    });
    expect(rpc.status).toBe(501);
  });

  test("validation errors are 400 with issues; unknown routes 404", async () => {
    const r = await alice.client.call<{ code: string; data: { issues: unknown[] } }>(
      "PATCH",
      `/api/channels/${alice.username}`,
      {
        title: "x".repeat(500),
      },
    );
    expect(r.status).toBe(400);
    expect(r.body.data.issues.length).toBeGreaterThan(0);
    expect((await client(api).call("GET", "/api/nope")).status).toBe(404);
  });

  test("CORS: trusted origins get credentials, others only bearer", async () => {
    const trusted = await fetch(`${api.url}/api/instance`, { headers: { origin: "http://localhost:3000" } });
    expect(trusted.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(trusted.headers.get("access-control-allow-credentials")).toBe("true");
    const other = await fetch(`${api.url}/api/me`, {
      headers: { origin: "https://evil.example.invalid", cookie: alice.client.jar.header() },
    });
    expect(other.headers.get("access-control-allow-origin")).toBe("*");
    expect(other.headers.get("access-control-allow-credentials")).toBeNull();
    // Cookies from untrusted origins are ignored.
    expect(other.status).toBe(401);
  });
});

test("rate limits answer RATE_LIMITED with retryAfterSeconds", async () => {
  const limited = await startApi({ rateLimits: { default: { max: 3, windowMs: 60_000 } } });
  try {
    const c = client(limited);
    for (let i = 0; i < 3; i++) expect((await c.call("GET", "/api/instance")).status).toBe(200);
    const r = await c.call<{ code: string; data: { retryAfterSeconds: number } }>("GET", "/api/instance");
    expect(r.status).toBe(429);
    expect(r.body.code).toBe("RATE_LIMITED");
    expect(r.body.data.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.res.headers.get("retry-after")).not.toBeNull();
  } finally {
    await limited.stop();
  }
}, 60_000);

test("anonymous playback calls use the playback bucket, not the per-address default", async () => {
  const limited = await startApi({
    rateLimits: { default: { max: 2, windowMs: 60_000 }, playback: { max: 3, windowMs: 60_000 } },
  });
  try {
    const c = client(limited);
    const end = () =>
      c.call<{ code: string }>("POST", "/api/playback/end", { sessionId: crypto.randomUUID(), token: "not-a-token" });
    // Past the default limit of 2, still admitted: the handler answers (the token is bad), not the limiter.
    for (let i = 0; i < 3; i++) expect((await end()).body.code).not.toBe("RATE_LIMITED");
    expect((await end()).status).toBe(429);
    // The default bucket is untouched by playback calls.
    expect((await c.call("GET", "/api/instance")).status).toBe(200);
  } finally {
    await limited.stop();
  }
}, 60_000);
