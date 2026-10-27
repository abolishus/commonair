// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P1 contract step (ADR 0005 amendment 1): opt-in P2P, the per-session grant, its refresh and
 * revocation, the digest URL, the operator default and the `p2p.iceServers` route.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  KEYS,
  mediaPath,
  P2P_GRANT_TTL_SECONDS,
} from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let clock = Date.now();
let realNow: () => Date;

type Start = {
  sessionId: string;
  token: string;
  p2p: { enabled: boolean; available: boolean; trackerUrls: string[]; swarmId: string; digestUrl: string };
};

const grant = (sid: string) => api.deps.valkey.get(KEYS.p2pGrant(sid));
const grantTtl = (sid: string) => api.deps.valkey.ttl(KEYS.p2pGrant(sid));

async function liveStreamer() {
  const s = await signUpAndSignIn(api);
  const res = await fetch(`${api.url}${INTERNAL_ROUTES.mediaReady}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(s.username), sourceType: "rtmpConn", sourceId: crypto.randomUUID() }),
  });
  if (res.status !== 204) throw new Error(`mediaReady failed: ${res.status}`);
  const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.slug, s.username));
  if (!c?.liveBroadcastId) throw new Error("not live");
  return { ...s, channelId: c.id, broadcastId: c.liveBroadcastId };
}

async function start(viewer: Client, slug: string, body: Record<string, unknown> = {}): Promise<Start> {
  const res = await viewer.call<Start>("POST", `/api/channels/${slug}/playback`, {
    deviceId: "device-0123456789abcdef",
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function beat(viewer: Client, s: Start, extra: Record<string, unknown> = {}) {
  clock += 10_000;
  return viewer.call<{ ok: boolean }>("POST", "/api/playback/heartbeat", {
    sessionId: s.sessionId,
    token: s.token,
    playedSeconds: 10,
    bufferSeconds: 3,
    stalls: 0,
    bytesHttp: 5000,
    bytesP2p: 0,
    rendition: "source",
    latencySeconds: 2,
    ttffMs: 800,
    visible: true,
    muted: false,
    ...extra,
  });
}

beforeAll(async () => {
  api = await startApi();
  realNow = api.deps.now;
  api.deps.now = () => new Date(clock);
}, 120_000);
afterAll(async () => {
  if (api) api.deps.now = realNow;
  await api?.stop();
});

describe("playback.start", () => {
  test("opted in: enabled, a tracker URL, and a grant holding the swarm id with the TTL", async () => {
    const st = await liveStreamer();
    const s = await start(client(api), st.username, { p2pCapable: true });
    expect(s.p2p).toMatchObject({ enabled: true, available: true, swarmId: st.broadcastId });
    expect(s.p2p.trackerUrls).toHaveLength(1);
    expect(await grant(s.sessionId)).toBe(st.broadcastId);
    const ttl = await grantTtl(s.sessionId);
    expect(ttl).toBeGreaterThan(P2P_GRANT_TTL_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(P2P_GRANT_TTL_SECONDS);
  });

  test("digestUrl is PLAYBACK_PUBLIC_URL + /p2p-digest, also when P2P is off", async () => {
    const st = await liveStreamer();
    const expected = `${api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "")}/p2p-digest`;
    expect((await start(client(api), st.username, { p2pCapable: true })).p2p.digestUrl).toBe(expected);
    expect((await start(client(api), st.username, { nativeHls: true })).p2p.digestUrl).toBe(expected);
  });

  test("not opted in: available but not enabled, no tracker URL, no grant", async () => {
    const st = await liveStreamer();
    const s = await start(client(api), st.username, { p2pCapable: false });
    expect(s.p2p).toMatchObject({ enabled: false, available: true, trackerUrls: [] });
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("p2pCapable omitted means no P2P", async () => {
    const st = await liveStreamer();
    const s = await start(client(api), st.username);
    expect(s.p2p).toMatchObject({ enabled: false, available: true, trackerUrls: [] });
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("native HLS and P2P_ENABLED=false: neither available nor enabled", async () => {
    const st = await liveStreamer();
    const native = await start(client(api), st.username, { p2pCapable: true, nativeHls: true });
    expect(native.p2p).toMatchObject({ enabled: false, available: false, trackerUrls: [] });
    expect(await grant(native.sessionId)).toBeNull();
    const env = api.deps.env as { P2P_ENABLED: boolean };
    env.P2P_ENABLED = false;
    try {
      const off = await start(client(api), st.username, { p2pCapable: true });
      expect(off.p2p).toMatchObject({ enabled: false, available: false });
      expect(await grant(off.sessionId)).toBeNull();
    } finally {
      env.P2P_ENABLED = true;
    }
  });

  test("a gated stream never gets P2P, even for a confirmed adult who opts in", async () => {
    const st = await liveStreamer();
    await api.db.db.update(schema.broadcasts).set({ mature: true }).where(eq(schema.broadcasts.id, st.broadcastId));
    const adult = await signUpAndSignIn(api);
    expect((await adult.client.call("POST", "/api/me/mature-confirmation")).status).toBe(200);
    const s = await start(adult.client, st.username, { p2pCapable: true });
    expect(s.p2p).toMatchObject({ enabled: false, available: false, trackerUrls: [] });
    expect(await grant(s.sessionId)).toBeNull();
  });
});

describe("grant lifetime", () => {
  test("a committed heartbeat refreshes the grant; P2P diagnostics are accepted", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { p2pCapable: true });
    await api.deps.valkey.expire(KEYS.p2pGrant(s.sessionId), 60);
    const r = await beat(viewer, s, { bytesP2p: 700, bytesP2pUp: 300, p2pPeers: 3, p2pRejected: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await grantTtl(s.sessionId)).toBeGreaterThan(P2P_GRANT_TTL_SECONDS - 10);
    expect(await grant(s.sessionId)).toBe(st.broadcastId);
  });

  test("a heartbeat never creates a grant for a session without one", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { p2pCapable: false });
    expect((await beat(viewer, s)).status).toBe(200);
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("a stream restricted mid-session loses its grant at the next heartbeat", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { p2pCapable: true });
    expect(await grant(s.sessionId)).toBe(st.broadcastId);
    await api.db.db
      .update(schema.broadcasts)
      .set({ restrictedAt: new Date(clock) })
      .where(eq(schema.broadcasts.id, st.broadcastId));
    expect((await beat(viewer, s)).status).toBe(200);
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("a channel marked mature mid-session loses its grant too", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { p2pCapable: true });
    await api.db.db.update(schema.channels).set({ mature: true }).where(eq(schema.channels.id, st.channelId));
    expect((await beat(viewer, s)).status).toBe(200);
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("playback.end deletes the grant", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { p2pCapable: true });
    const r = await viewer.call("POST", "/api/playback/end", { sessionId: s.sessionId, token: s.token });
    expect(r.status).toBe(200);
    expect(await grant(s.sessionId)).toBeNull();
  });
});

describe("instance and routes", () => {
  test("instance.info reports the operator default, off by default", async () => {
    const r = await client(api).call<{ features: { p2p: boolean; p2pDefault: string } }>("GET", "/api/instance");
    expect(r.status).toBe(200);
    expect(r.body.features).toMatchObject({ p2p: true, p2pDefault: "off" });
  });

  test("p2p.iceServers is registered (stub until P1-turn)", async () => {
    const st = await liveStreamer();
    const s = await start(client(api), st.username, { p2pCapable: true });
    const r = await client(api).call<{ code: string }>("POST", "/api/playback/ice-servers", {
      sessionId: s.sessionId,
      token: s.token,
    });
    expect(r.status).toBe(501);
    expect(r.body.code).toBe("NOT_IMPLEMENTED");
  });
});
