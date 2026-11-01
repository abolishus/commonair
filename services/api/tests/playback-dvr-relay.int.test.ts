// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay DVR grants (batch 7 decision (x), ADR 0016 Amendment 1 A1.3): a relay-assigned session
 * that passes every W2-dvr gate rewinds on its relay with a relay DVR token for that relay;
 * origin- and CDN-assigned sessions keep origin DVR (the CDN never serves DVR). The heartbeat
 * refreshes the DVR token for the session's current assignment, so a session moved off its relay
 * gets an origin DVR token.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { dataModeCeilingBps, DVR_TOKEN_TTL_SECONDS } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { dvrTokenPath, vodPrefix } from "@commonair/contracts/storage";
import { PLAYBACK_TOKEN_TTL_SECONDS, type PlaybackClaims } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let clock = Date.now();
let realNow: () => Date;

type Start = {
  sessionId: string;
  token: string;
  playlistUrl: string;
  source: "origin" | "cdn" | "relay";
  dvrWindowSeconds: number;
  dvrPlaylistUrl: string | null;
};
type Beat = { ok: boolean; token?: string; dvrToken?: string; switchTo?: string };
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type MutableEnv = {
  CDN_PROVIDER: "none" | "origin-pull";
  CDN_BASE_URL: string | undefined;
  CDN_BURST_VIEWER_THRESHOLD: number;
};
const env = () => api.deps.env as unknown as MutableEnv;
const db = () => api.db.db;
const RELAY_URL = "https://relay-dvr.example.invalid";
const ORIGIN = () => api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "");
let relayId: string;
let stranger: User;

const claimsOf = async (token: string): Promise<PlaybackClaims> => {
  const r = await verifyPlaybackToken(api.deps.signingKey.publicKey, token, Math.floor(clock / 1000));
  if (!r.ok) throw new Error(`token does not verify: ${r.error}`);
  return r.value;
};
const tokenOfUrl = (url: string) => new URL(url).searchParams.get("t") ?? "";

interface Live {
  owner: User;
  channelId: string;
  vodId: string;
}

async function liveRecording(visibility: "public" | "private" = "public", viewers = 0): Promise<Live> {
  const owner = await signUpAndSignIn(api);
  await db().update(schema.channels).set({ vodEnabled: true }).where(eq(schema.channels.slug, owner.username));
  const res = await fetch(`${api.url}${INTERNAL_ROUTES.mediaReady}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(owner.username), sourceType: "rtmpConn", sourceId: crypto.randomUUID() }),
  });
  if (res.status !== 204) throw new Error(`mediaReady failed: ${res.status}`);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  if (!c?.liveBroadcastId) throw new Error("not live");
  const vodId = uuidv7();
  await db()
    .insert(schema.vods)
    .values({
      id: vodId,
      channelId: c.id,
      broadcastId: c.liveBroadcastId,
      title: "live",
      visibility,
      storagePrefix: vodPrefix(vodId, "private"),
    });
  await api.deps.valkey.set(KEYS.viewerCount(c.id), String(viewers), "EX", 600);
  return { owner, channelId: c.id, vodId };
}

async function start(viewer: Client, slug: string, body: Record<string, unknown> = {}): Promise<Start> {
  const res = await viewer.call<Start>("POST", `/api/channels/${slug}/playback`, {
    deviceId: "device-0123456789abcdef",
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Start sessions until one lands on `source` (assignment is a hash of the session id). */
async function startOn(source: Start["source"], viewer: () => Client, slug: string): Promise<Start> {
  for (let i = 0; i < 60; i++) {
    const s = await start(viewer(), slug);
    if (s.source === source) return s;
  }
  throw new Error(`no session drawn onto ${source} in 60 tries`);
}

async function beat(viewer: Client, s: Start, token: string): Promise<Beat> {
  clock += (PLAYBACK_TOKEN_TTL_SECONDS - 60) * 1000;
  const res = await viewer.call<Beat>("POST", "/api/playback/heartbeat", {
    sessionId: s.sessionId,
    token,
    playedSeconds: 10,
    bufferSeconds: 3,
    stalls: 0,
    bytesHttp: 5000,
    bytesP2p: 0,
    rendition: "source",
    latencySeconds: null,
    ttffMs: 800,
    visible: true,
    muted: false,
    playbackMode: "dvr",
    behindLiveSeconds: 60,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function expectRelayDvr(s: Start, live: Live) {
  expect(s.dvrWindowSeconds).toBeGreaterThan(0);
  expect(s.dvrPlaylistUrl?.startsWith(`${RELAY_URL}/dvr/${live.vodId}/index.m3u8?t=`)).toBe(true);
  const claims = await claimsOf(tokenOfUrl(s.dvrPlaylistUrl ?? ""));
  expect(claims).toMatchObject({ sid: s.sessionId, cid: live.channelId, path: dvrTokenPath(live.vodId), src: "relay" });
  expect(claims.rid).toBe(relayId);
  expect(claims.dm).toBeUndefined();
  expect(claims.exp - claims.iat).toBe(DVR_TOKEN_TTL_SECONDS);
}

async function expectOriginDvr(s: Start, live: Live) {
  expect(s.dvrWindowSeconds).toBeGreaterThan(0);
  expect(s.dvrPlaylistUrl?.startsWith(`${ORIGIN()}/dvr/${live.vodId}/index.m3u8?t=`)).toBe(true);
  const claims = await claimsOf(tokenOfUrl(s.dvrPlaylistUrl ?? ""));
  expect(claims).toMatchObject({ sid: s.sessionId, path: dvrTokenPath(live.vodId), src: "origin" });
  expect(claims.rid).toBeUndefined();
}

const expectNone = (s: Start) => expect([s.dvrWindowSeconds, s.dvrPlaylistUrl]).toEqual([0, null]);

async function publishRelay() {
  await api.deps.valkey.hset(
    KEYS.relays,
    relayId,
    JSON.stringify({ url: RELAY_URL, capacityMbps: 1000, status: "active", load: 0 }),
  );
}

beforeAll(async () => {
  api = await startApi();
  realNow = api.deps.now;
  api.deps.now = () => new Date(clock);
  stranger = await signUpAndSignIn(api);
  relayId = uuidv7();
  await db()
    .insert(schema.relayNodes)
    .values({
      id: relayId,
      ownerId: stranger.userId,
      name: "dvr relay",
      publicUrl: RELAY_URL,
      declaredCapacityMbps: 1000,
      publicKey: "test",
      tokenHash: `dvr-relay-${relayId}`,
      status: "active",
    });
}, 120_000);
afterAll(async () => {
  if (api) api.deps.now = realNow;
  await api?.stop();
});
beforeEach(async () => {
  Object.assign(env(), { CDN_PROVIDER: "none", CDN_BASE_URL: undefined, CDN_BURST_VIEWER_THRESHOLD: 10 });
  await publishRelay();
});

describe("playback.start: who rewinds where", () => {
  test("relay-assigned: on the relay with a relay token; origin-assigned: on the origin", async () => {
    const live = await liveRecording();
    await expectRelayDvr(await startOn("relay", () => client(api), live.owner.username), live);
    await expectOriginDvr(await startOn("origin", () => client(api), live.owner.username), live);
  });

  test("CDN-assigned: origin DVR (the CDN never serves DVR)", async () => {
    await api.deps.valkey.del(KEYS.relays);
    const live = await liveRecording("public", 100);
    Object.assign(env(), { CDN_PROVIDER: "origin-pull", CDN_BASE_URL: "https://cdn.example.invalid" });
    const s = await start(client(api), live.owner.username);
    expect(s.source).toBe("cdn");
    await expectOriginDvr(s, live);
  });

  test("W2-dvr's gates still decide: a private recording rewinds for nobody but the owner, on any source", async () => {
    const live = await liveRecording("private");
    expectNone(await startOn("relay", () => stranger.client, live.owner.username));
    expectNone(await startOn("origin", () => stranger.client, live.owner.username));
    await expectRelayDvr(await startOn("relay", () => live.owner.client, live.owner.username), live);
  });

  test("data mode: an origin session and no DVR at all", async () => {
    const live = await liveRecording();
    for (let i = 0; i < 6; i++) {
      const s = await start(client(api), live.owner.username, { dataMode: dataModeCeilingBps(800) });
      expect(s.source).toBe("origin");
      expectNone(s);
    }
  });

  test("DVR off for the channel: no relay DVR either", async () => {
    const live = await liveRecording();
    await db().update(schema.channels).set({ dvrEnabled: false }).where(eq(schema.channels.id, live.channelId));
    expectNone(await startOn("relay", () => client(api), live.owner.username));
  });
});

describe("heartbeat: the DVR token follows the assignment", () => {
  test("a relay session's refreshed DVR token is a relay token; moved off the relay, an origin one", async () => {
    const live = await liveRecording();
    const viewer = client(api);
    let s: Start | undefined;
    for (let i = 0; i < 60 && !s; i++) {
      const t = await start(viewer, live.owner.username);
      if (t.source === "relay") s = t;
    }
    if (!s) throw new Error("no relay session");
    const r = await beat(viewer, s, s.token);
    expect(r.switchTo).toBeUndefined();
    const refreshed = await claimsOf(r.dvrToken ?? "");
    expect(refreshed).toMatchObject({ sid: s.sessionId, path: dvrTokenPath(live.vodId), src: "relay", rid: relayId });

    // The relay leaves the active set: the session moves to the origin, and so does its DVR token.
    await api.deps.valkey.hdel(KEYS.relays, relayId);
    const moved = await beat(viewer, s, r.token ?? s.token);
    expect(moved.switchTo?.startsWith(ORIGIN())).toBe(true);
    const originDvr = await claimsOf(moved.dvrToken ?? "");
    expect(originDvr).toMatchObject({ sid: s.sessionId, path: dvrTokenPath(live.vodId), src: "origin" });
    expect(originDvr.rid).toBeUndefined();
  });
});
