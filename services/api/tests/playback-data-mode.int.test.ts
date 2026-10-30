// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W1-data-mode (ADR 0018 decisions 3, 4 and 6): `playback.start` mints `dm` and keeps data-mode
 * sessions on the origin without P2P; the heartbeat carries `dm` across refreshes, re-mints at once
 * when it changes, moves relay and CDN sessions to the origin when it turns on and leaves them
 * where they are when it turns off.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { dataModeCeilingBps } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { PLAYBACK_TOKEN_TTL_SECONDS } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
// The handlers read `deps.now()`; pinning it keeps token expiry independent of the host clock.
let clock = Date.now();
let realNow: () => Date;

type Start = {
  sessionId: string;
  token: string;
  playlistUrl: string;
  source: "origin" | "cdn" | "relay";
  dataMode: number | null;
  p2p: { enabled: boolean; available: boolean; trackerUrls: string[] };
};
type Beat = { ok: boolean; token?: string; switchTo?: string; throttled?: boolean };
type MutableEnv = {
  CDN_PROVIDER: "none" | "origin-pull";
  CDN_BASE_URL: string | undefined;
  CDN_BURST_VIEWER_THRESHOLD: number;
  P2P_ENABLED: boolean;
};
const env = () => api.deps.env as unknown as MutableEnv;

const AUDIO = dataModeCeilingBps(50);
const LOW = dataModeCeilingBps(800);
const RELAY_URL = "https://relay.example.invalid";

const claimsOf = async (token: string) => {
  const r = await verifyPlaybackToken(api.deps.signingKey.publicKey, token, Math.floor(clock / 1000));
  if (!r.ok) throw new Error(`token does not verify: ${r.error}`);
  return r.value;
};
const grant = (sid: string) => api.deps.valkey.get(KEYS.p2pGrant(sid));
const sessionRow = async (sid: string) => {
  const [row] = await api.db.db.select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, sid));
  if (!row) throw new Error("no session row");
  return row;
};

async function liveStreamer(viewers = 0) {
  const s = await signUpAndSignIn(api);
  const res = await fetch(`${api.url}${INTERNAL_ROUTES.mediaReady}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(s.username), sourceType: "rtmpConn", sourceId: crypto.randomUUID() }),
  });
  if (res.status !== 204) throw new Error(`mediaReady failed: ${res.status}`);
  const [c] = await api.db.db.select().from(schema.channels).where(eq(schema.channels.slug, s.username));
  if (!c?.liveBroadcastId) throw new Error("not live");
  // The cached public count is what assignment compares with the CDN threshold (10, below).
  await api.deps.valkey.set(KEYS.viewerCount(c.id), String(viewers), "EX", 600);
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

async function beat(viewer: Client, sid: string, token: string, extra: Record<string, unknown> = {}) {
  clock += 10_000;
  const res = await viewer.call<Beat>("POST", "/api/playback/heartbeat", {
    sessionId: sid,
    token,
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
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** A session the delivery draw put on the relay (the draw is a hash of the session id: retry). */
async function relaySession(viewer: Client, slug: string, body: Record<string, unknown> = {}): Promise<Start> {
  for (let i = 0; i < 40; i++) {
    const s = await start(viewer, slug, body);
    if (s.source === "relay") return s;
  }
  throw new Error("no session drawn onto the relay in 40 tries");
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
beforeEach(async () => {
  Object.assign(env(), {
    CDN_PROVIDER: "origin-pull",
    CDN_BASE_URL: "https://cdn.example.invalid",
    CDN_BURST_VIEWER_THRESHOLD: 10,
    P2P_ENABLED: true,
  } satisfies MutableEnv);
  await api.deps.valkey.del(KEYS.relays);
});

/** An active relay: the `relay_nodes` row `playback_sessions.relay_id` references, and its entry. */
async function addRelay(ownerId: string): Promise<string> {
  const id = uuidv7();
  await api.db.db.insert(schema.relayNodes).values({
    id,
    ownerId,
    name: "data-mode test relay",
    publicUrl: RELAY_URL,
    declaredCapacityMbps: 1000,
    publicKey: "test",
    tokenHash: `data-mode-${id}`,
    status: "active",
  });
  await api.deps.valkey.hset(
    KEYS.relays,
    id,
    JSON.stringify({ url: RELAY_URL, capacityMbps: 1000, status: "active", load: 0 }),
  );
  return id;
}

describe("playback.start with dataMode", () => {
  test("mints dm, echoes dataMode and stays on the origin above the CDN threshold", async () => {
    const st = await liveStreamer(100);
    const s = await start(client(api), st.username, { dataMode: AUDIO });
    expect(s).toMatchObject({ source: "origin", dataMode: AUDIO });
    expect(s.playlistUrl.startsWith(api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, ""))).toBe(true);
    expect(await claimsOf(s.token)).toMatchObject({ src: "origin", dm: AUDIO });
    expect((await sessionRow(s.sessionId)).assignedSource).toBe("origin");
  });

  test("without dataMode the token has no dm and the CDN still takes the session", async () => {
    const st = await liveStreamer(100);
    const s = await start(client(api), st.username);
    expect(s).toMatchObject({ source: "cdn", dataMode: null });
    expect((await claimsOf(s.token)).dm).toBeUndefined();
    const explicit = await start(client(api), st.username, { dataMode: null });
    expect(explicit.dataMode).toBeNull();
  });

  test("data-mode sessions are never drawn onto a relay", async () => {
    const st = await liveStreamer();
    await addRelay(st.userId);
    for (let i = 0; i < 12; i++) {
      const s = await start(client(api), st.username, { dataMode: LOW });
      expect(s.source).toBe("origin");
    }
  });

  test("no P2P grant in data mode, even when the player sends p2pCapable", async () => {
    const st = await liveStreamer();
    const s = await start(client(api), st.username, { dataMode: AUDIO, p2pCapable: true });
    expect(s.p2p).toMatchObject({ enabled: false, available: false, trackerUrls: [] });
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("out-of-range ceilings are refused by the contract", async () => {
    const st = await liveStreamer();
    for (const dataMode of [1000, 9_000_000, 1.5]) {
      const res = await client(api).call("POST", `/api/channels/${st.username}/playback`, {
        deviceId: "device-0123456789abcdef",
        dataMode,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("heartbeat with dataMode", () => {
  test("dm is carried forward when the beat omits dataMode, on every refresh", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { dataMode: AUDIO });
    // Far from expiry and unchanged: no new token.
    expect((await beat(viewer, s.sessionId, s.token)).token).toBeUndefined();
    let token = s.token;
    for (let i = 0; i < 2; i++) {
      // Inside the refresh window: a new token that still carries the ceiling.
      clock += (PLAYBACK_TOKEN_TTL_SECONDS - 60) * 1000;
      const r = await beat(viewer, s.sessionId, token);
      expect(r.token).toBeDefined();
      expect(r.switchTo).toBeUndefined();
      token = r.token ?? "";
      expect(await claimsOf(token)).toMatchObject({ src: "origin", dm: AUDIO });
    }
    // Sending the same ceiling is not a change.
    expect((await beat(viewer, s.sessionId, token, { dataMode: AUDIO })).token).toBeUndefined();
  });

  test("a changed ceiling re-mints at once; null turns it off and the session stays on the origin", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { dataMode: AUDIO });
    const raised = await beat(viewer, s.sessionId, s.token, { dataMode: LOW });
    expect(raised.token).toBeDefined();
    expect(raised.switchTo).toBeUndefined();
    expect((await claimsOf(raised.token ?? "")).dm).toBe(LOW);

    const off = await beat(viewer, s.sessionId, raised.token ?? "", { dataMode: null });
    expect(off.token).toBeDefined();
    expect(off.switchTo).toBeUndefined();
    const claims = await claimsOf(off.token ?? "");
    expect(claims.dm).toBeUndefined();
    expect(claims.src).toBe("origin");
    expect((await sessionRow(s.sessionId)).assignedSource).toBe("origin");
  });

  test("turning it on for an origin session re-mints without switchTo", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username);
    expect(s.source).toBe("origin");
    const on = await beat(viewer, s.sessionId, s.token, { dataMode: AUDIO });
    expect(on.switchTo).toBeUndefined();
    expect(await claimsOf(on.token ?? "")).toMatchObject({ src: "origin", dm: AUDIO });
  });

  test("turning it on moves a CDN session to the origin with switchTo; turning it off stays", async () => {
    const st = await liveStreamer(100);
    const viewer = client(api);
    const s = await start(viewer, st.username);
    expect(s.source).toBe("cdn");
    const on = await beat(viewer, s.sessionId, s.token, { dataMode: AUDIO });
    expect(on.token).toBeDefined();
    const origin = api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "");
    expect(on.switchTo?.startsWith(`${origin}/hls/${mediaPath(st.username)}/index.m3u8?t=`)).toBe(true);
    expect(on.switchTo).toContain(encodeURIComponent(on.token ?? ""));
    expect(await claimsOf(on.token ?? "")).toMatchObject({ src: "origin", dm: AUDIO });
    expect(await sessionRow(s.sessionId)).toMatchObject({ assignedSource: "origin", relayId: null });

    const off = await beat(viewer, s.sessionId, on.token ?? "", { dataMode: null });
    expect(off.switchTo).toBeUndefined();
    expect((await claimsOf(off.token ?? "")).src).toBe("origin");
    expect((await sessionRow(s.sessionId)).assignedSource).toBe("origin");
  });

  test("turning it on moves a relay session to the origin and clears relay_id", async () => {
    const st = await liveStreamer();
    const relayId = await addRelay(st.userId);
    const viewer = client(api);
    const s = await relaySession(viewer, st.username);
    expect((await sessionRow(s.sessionId)).relayId).toBe(relayId);
    const on = await beat(viewer, s.sessionId, s.token, { dataMode: LOW });
    expect(on.switchTo?.startsWith(api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, ""))).toBe(true);
    const claims = await claimsOf(on.token ?? "");
    expect(claims).toMatchObject({ src: "origin", dm: LOW });
    expect(claims.rid).toBeUndefined();
    expect(await sessionRow(s.sessionId)).toMatchObject({ assignedSource: "origin", relayId: null });
  });

  test("turning it off on a relay session that never had it keeps the relay", async () => {
    const st = await liveStreamer();
    await addRelay(st.userId);
    const viewer = client(api);
    const s = await relaySession(viewer, st.username);
    const r = await beat(viewer, s.sessionId, s.token, { dataMode: null });
    // null on a session without dm is no change: no re-mint, no move.
    expect(r.token).toBeUndefined();
    expect(r.switchTo).toBeUndefined();
    expect((await sessionRow(s.sessionId)).assignedSource).toBe("relay");
  });

  test("a heartbeat turning data mode on deletes the P2P grant", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username, { p2pCapable: true });
    expect(await grant(s.sessionId)).toBe(st.broadcastId);
    const on = await beat(viewer, s.sessionId, s.token, { dataMode: AUDIO });
    expect(on.token).toBeDefined();
    expect(await grant(s.sessionId)).toBeNull();
  });

  test("a throttled beat changes nothing; the next beat at the normal interval applies the change", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username);
    await beat(viewer, s.sessionId, s.token);
    clock -= 9_000;
    const throttled = await beat(viewer, s.sessionId, s.token, { dataMode: AUDIO });
    expect(throttled).toMatchObject({ ok: true, throttled: true });
    expect(throttled.token).toBeUndefined();
    const applied = await beat(viewer, s.sessionId, s.token, { dataMode: AUDIO });
    expect((await claimsOf(applied.token ?? "")).dm).toBe(AUDIO);
  });
});
