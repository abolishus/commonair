// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `p2p.iceServers` (P1-turn, ADR 0005 amendment 1 decision 2) against real Postgres and Valkey:
 * only a granted, live session gets ICE servers; TURN credentials only with the relay configured.
 */
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { signPlaybackToken } from "@commonair/tokens";
import type { Deps } from "../src/index.ts";
import { turnOpaqueId } from "../src/p2p/turn.ts";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

const STUN = "stun:turn.instance.test:3478";
const TURN = "turn:turn.instance.test:3478?transport=udp";
const SECRET = "p2p-int-test-shared-secret-0123456789abcdef";
const TTL = 1200;

let api: TestApi;
let clock = Date.now();
let realNow: () => Date;

type Start = { sessionId: string; token: string; p2p: { enabled: boolean } };
type Ice = { iceServers: { urls: string[]; username?: string; credential?: string }[]; expiresAt: string | null };
type Err = { code: string; message: string; data?: unknown };

const env = () => api.deps.env as { P2P_STUN_URLS: string[]; P2P_TURN_URLS: string[]; TURN_SHARED_SECRET?: string };

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

async function start(viewer: Client, slug: string, p2pCapable = true): Promise<Start> {
  const res = await viewer.call<Start>("POST", `/api/channels/${slug}/playback`, {
    deviceId: "device-0123456789abcdef",
    p2pCapable,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const ice = <T = Ice>(viewer: Client, sessionId: string, token: string) =>
  viewer.call<T>("POST", "/api/playback/ice-servers", { sessionId, token });

let slug: string;

beforeAll(async () => {
  api = await startApi({
    env: {
      P2P_STUN_URLS: STUN,
      P2P_TURN_URLS: TURN,
      TURN_SHARED_SECRET: SECRET,
      TURN_CREDENTIAL_TTL_SECONDS: String(TTL),
    },
  });
  realNow = api.deps.now;
  api.deps.now = () => new Date(clock);
  slug = (await liveStreamer()).username;
}, 120_000);
afterAll(async () => {
  if (api) api.deps.now = realNow;
  await api?.stop();
});

describe("a granted session", () => {
  test("gets the STUN entry and a TURN entry with TURN REST credentials expiring after the TTL", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    expect(s.p2p.enabled).toBe(true);
    const r = await ice(viewer, s.sessionId, s.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [stun, turn, ...rest] = r.body.iceServers;
    expect(rest).toEqual([]);
    expect(stun).toEqual({ urls: [STUN] });
    expect(turn?.urls).toEqual([TURN]);
    const expiry = Math.floor(clock / 1000) + TTL;
    expect(turn?.username).toBe(`${expiry}:${turnOpaqueId(SECRET, s.sessionId)}`);
    expect(turn?.username).not.toContain(s.sessionId);
    expect(turn?.credential).toBe(
      createHmac("sha1", SECRET)
        .update(turn?.username ?? "")
        .digest("base64"),
    );
    expect(r.body.expiresAt).toBe(new Date(expiry * 1000).toISOString());
  });

  test("calling again refreshes: a later expiry, the same opaque id", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    const first = (await ice(viewer, s.sessionId, s.token)).body.iceServers[1]?.username ?? "";
    clock += 30_000;
    const second = (await ice(viewer, s.sessionId, s.token)).body.iceServers[1]?.username ?? "";
    expect(Number(second.split(":")[0])).toBe(Number(first.split(":")[0]) + 30);
    expect(second.split(":")[1]).toBe(first.split(":")[1]);
  });

  test("relay off (no P2P_TURN_URLS): STUN only, nothing expires", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    const saved = env().P2P_TURN_URLS;
    env().P2P_TURN_URLS = [];
    try {
      const r = await ice(viewer, s.sessionId, s.token);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ iceServers: [{ urls: [STUN] }], expiresAt: null });
    } finally {
      env().P2P_TURN_URLS = saved;
    }
  });

  test("nothing configured: an empty list", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    const saved = { stun: env().P2P_STUN_URLS, turn: env().P2P_TURN_URLS };
    env().P2P_STUN_URLS = [];
    env().P2P_TURN_URLS = [];
    try {
      const r = await ice(viewer, s.sessionId, s.token);
      expect(r.body).toEqual({ iceServers: [], expiresAt: null });
    } finally {
      env().P2P_STUN_URLS = saved.stun;
      env().P2P_TURN_URLS = saved.turn;
    }
  });

  test("TURN configured without a secret (hand-built deps): fails closed, leaks nothing", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    const saved = env().TURN_SHARED_SECRET;
    delete env().TURN_SHARED_SECRET;
    try {
      const r = await ice<Err>(viewer, s.sessionId, s.token);
      expect(r.status).toBe(500);
      expect(r.body.code).toBe("INTERNAL_SERVER_ERROR");
      expect(JSON.stringify(r.body)).not.toMatch(/stun:|turn:|SECRET/);
    } finally {
      env().TURN_SHARED_SECRET = saved;
    }
  });
});

describe("refusals", () => {
  test("no grant (not opted in): PRECONDITION_FAILED with requirement p2p", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug, false);
    const r = await ice<Err>(viewer, s.sessionId, s.token);
    expect(r.status).toBe(412);
    expect(r.body.code).toBe("PRECONDITION_FAILED");
    expect(r.body.data).toEqual({ requirement: "p2p" });
  });

  test("a grant revoked mid-session (stream restricted) is refused from the next heartbeat on", async () => {
    const st = await liveStreamer();
    const viewer = client(api);
    const s = await start(viewer, st.username);
    expect((await ice(viewer, s.sessionId, s.token)).status).toBe(200);
    await api.db.db
      .update(schema.broadcasts)
      .set({ restrictedAt: new Date(clock) })
      .where(eq(schema.broadcasts.id, st.broadcastId));
    clock += 10_000;
    const beat = await viewer.call("POST", "/api/playback/heartbeat", {
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
    });
    expect(beat.status).toBe(200);
    expect(await api.deps.valkey.exists(KEYS.p2pGrant(s.sessionId))).toBe(0);
    expect((await ice<Err>(viewer, s.sessionId, s.token)).body.data).toEqual({ requirement: "p2p" });
  });

  test("a bad token, or another session's token: UNAUTHORIZED", async () => {
    const viewer = client(api);
    const a = await start(viewer, slug);
    const b = await start(viewer, slug);
    expect((await ice<Err>(viewer, a.sessionId, "not-a-token")).status).toBe(401);
    const swapped = await ice<Err>(viewer, a.sessionId, b.token);
    expect(swapped.status).toBe(401);
    expect(swapped.body.code).toBe("UNAUTHORIZED");
  });

  test("an expired token: UNAUTHORIZED", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    clock += 10 * 60_000;
    expect((await ice(viewer, s.sessionId, s.token)).status).toBe(401);
  });

  test("a valid token for a session that does not exist: NOT_FOUND", async () => {
    const sid = crypto.randomUUID();
    const iat = Math.floor(clock / 1000);
    const token = await signPlaybackToken((api.deps as Deps).signingKey, {
      v: 1,
      sid,
      cid: crypto.randomUUID(),
      path: mediaPath(slug),
      src: "origin",
      iat,
      exp: iat + 60,
    });
    // A grant alone does not make a session.
    await api.deps.valkey.set(KEYS.p2pGrant(sid), crypto.randomUUID(), "EX", 60);
    const r = await ice<Err>(client(api), sid, token);
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_FOUND");
  });

  test("an ended session: CONFLICT, even with a grant left behind", async () => {
    const viewer = client(api);
    const s = await start(viewer, slug);
    expect((await viewer.call("POST", "/api/playback/end", { sessionId: s.sessionId, token: s.token })).status).toBe(
      200,
    );
    await api.deps.valkey.set(KEYS.p2pGrant(s.sessionId), crypto.randomUUID(), "EX", 60);
    const r = await ice<Err>(viewer, s.sessionId, s.token);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("CONFLICT");
  });
});

describe("rate limit", () => {
  test("counts against the playback bucket like heartbeats, not the default one", async () => {
    const limits = api.deps.rateLimits as Deps["rateLimits"];
    const saved = { playback: limits.playback, default: limits.default };
    // Past every earlier hit's window, so the counts below start from zero.
    clock += 10 * 60_000;
    const viewer = client(api);
    const s = await start(viewer, slug);
    limits.playback = { max: 3, windowMs: 60_000 };
    limits.default = { max: 1, windowMs: 60_000 };
    try {
      // start was the first playback hit; two more pass, beyond the default bucket's 1.
      expect((await ice(viewer, s.sessionId, s.token)).status).toBe(200);
      expect((await ice(viewer, s.sessionId, s.token)).status).toBe(200);
      const limited = await ice<Err>(viewer, s.sessionId, s.token);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("RATE_LIMITED");
    } finally {
      limits.playback = saved.playback;
      limits.default = saved.default;
    }
  });
});
