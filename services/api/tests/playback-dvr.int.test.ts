// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W2-dvr (ADR 0016 decisions 1, 2, 5, 6 and 7): who `playback.start` grants DVR, the window clamp,
 * the DVR URL on the origin for every delivery source, heartbeat `playback_mode` / `dvr_seconds`
 * recording and the DVR token refreshed beside the live one.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { dataModeCeilingBps, DVR_TOKEN_TTL_SECONDS } from "@commonair/contracts/enums";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { dvrTokenPath, vodPrefix } from "@commonair/contracts/storage";
import { PLAYBACK_TOKEN_TTL_SECONDS } from "@commonair/contracts/tokens";
import { schema, uuidv7 } from "@commonair/db";
import { verifyPlaybackToken } from "@commonair/tokens";
import { dvrWindowSeconds } from "../src/routes/playback.ts";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;
let clock = Date.now();
let realNow: () => Date;

type Start = {
  sessionId: string;
  token: string;
  source: "origin" | "cdn" | "relay";
  dvrWindowSeconds: number;
  dvrPlaylistUrl: string | null;
};
type Beat = { ok: boolean; token?: string; dvrToken?: string; throttled?: boolean };
type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type MutableEnv = {
  CDN_PROVIDER: "none" | "origin-pull";
  CDN_BASE_URL: string | undefined;
  CDN_BURST_VIEWER_THRESHOLD: number;
  DVR_MAX_WINDOW_SECONDS: number;
};
const env = () => api.deps.env as unknown as MutableEnv;
const db = () => api.db.db;
const ORIGIN = () => api.deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, "");

const claimsOf = async (token: string) => {
  const r = await verifyPlaybackToken(api.deps.signingKey.publicKey, token, Math.floor(clock / 1000));
  if (!r.ok) throw new Error(`token does not verify: ${r.error}`);
  return r.value;
};
const tokenOfUrl = (url: string) => new URL(url).searchParams.get("t") ?? "";
const sessionRow = async (sid: string) => {
  const [row] = await db().select().from(schema.playbackSessions).where(eq(schema.playbackSessions.id, sid));
  if (!row) throw new Error("no session row");
  return row;
};

interface Live {
  owner: User;
  channelId: string;
  broadcastId: string;
  vodId: string;
}

/** A live channel (VODs on unless told otherwise) whose broadcast records a VOD. */
async function liveRecording(
  opts: { visibility?: "public" | "subscribers" | "private"; vodEnabled?: boolean; viewers?: number } = {},
): Promise<Live> {
  const owner = await signUpAndSignIn(api);
  await db()
    .update(schema.channels)
    .set({ vodEnabled: opts.vodEnabled ?? true })
    .where(eq(schema.channels.slug, owner.username));
  const res = await fetch(`${api.url}${INTERNAL_ROUTES.mediaReady}`, {
    method: "POST",
    headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: api.internalSecret },
    body: JSON.stringify({ path: mediaPath(owner.username), sourceType: "rtmpConn", sourceId: crypto.randomUUID() }),
  });
  if (res.status !== 204) throw new Error(`mediaReady failed: ${res.status}`);
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, owner.username));
  if (!c?.liveBroadcastId) throw new Error("not live");
  // The media service creates the recording's VOD row when VODs are on.
  const vodId = uuidv7();
  await db()
    .insert(schema.vods)
    .values({
      id: vodId,
      channelId: c.id,
      broadcastId: c.liveBroadcastId,
      title: "live",
      visibility: opts.visibility ?? "public",
      storagePrefix: vodPrefix(vodId, "private"),
    });
  await api.deps.valkey.set(KEYS.viewerCount(c.id), String(opts.viewers ?? 0), "EX", 600);
  return { owner, channelId: c.id, broadcastId: c.liveBroadcastId, vodId };
}

async function subscribe(user: User, channelId: string) {
  await db().insert(schema.subscriptions).values({
    subscriberId: user.userId,
    channelId,
    tier: 1,
    status: "active",
    provider: "manual",
    priceCents: 500,
    currency: "usd",
  });
}

async function startRaw(viewer: Client, slug: string, body: Record<string, unknown> = {}) {
  return viewer.call<Start>("POST", `/api/channels/${slug}/playback`, { deviceId: "device-0123456789abcdef", ...body });
}
async function start(viewer: Client, slug: string, body: Record<string, unknown> = {}): Promise<Start> {
  const res = await startRaw(viewer, slug, body);
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
    latencySeconds: null,
    ttffMs: 800,
    visible: true,
    muted: false,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

/** Granted: a window and a DVR URL on the origin whose token covers exactly `dvr/<vodId>`. */
async function expectGranted(s: Start, live: Live, windowSeconds = 1800) {
  expect(s.dvrWindowSeconds).toBe(windowSeconds);
  expect(s.dvrPlaylistUrl?.startsWith(`${ORIGIN()}/dvr/${live.vodId}/index.m3u8?t=`)).toBe(true);
  const claims = await claimsOf(tokenOfUrl(s.dvrPlaylistUrl ?? ""));
  expect(claims).toMatchObject({
    sid: s.sessionId,
    cid: live.channelId,
    path: dvrTokenPath(live.vodId),
    src: "origin",
  });
  expect(claims.dm).toBeUndefined();
  expect(claims.rid).toBeUndefined();
  expect(claims.exp - claims.iat).toBe(DVR_TOKEN_TTL_SECONDS);
}
const expectNone = (s: Start) => expect([s.dvrWindowSeconds, s.dvrPlaylistUrl]).toEqual([0, null]);

let stranger: User;
let subscriber: User;

beforeAll(async () => {
  api = await startApi();
  realNow = api.deps.now;
  api.deps.now = () => new Date(clock);
  [stranger, subscriber] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
}, 120_000);
afterAll(async () => {
  if (api) api.deps.now = realNow;
  await api?.stop();
});
beforeEach(async () => {
  Object.assign(env(), {
    CDN_PROVIDER: "none",
    CDN_BASE_URL: undefined,
    CDN_BURST_VIEWER_THRESHOLD: 10,
    DVR_MAX_WINDOW_SECONDS: 7200,
  } satisfies MutableEnv);
  await api.deps.valkey.del(KEYS.relays);
});

describe("playback.start: the DVR grant matrix", () => {
  test.each<["public" | "subscribers" | "private", { anon: boolean; stranger: boolean; subscriber: boolean }]>([
    ["public", { anon: true, stranger: true, subscriber: true }],
    ["subscribers", { anon: false, stranger: false, subscriber: true }],
    ["private", { anon: false, stranger: false, subscriber: false }],
  ])("a %s VOD", async (visibility, grants) => {
    const live = await liveRecording({ visibility });
    await subscribe(subscriber, live.channelId);
    const viewers: [string, Client, boolean][] = [
      ["signed out", client(api), grants.anon],
      ["stranger", stranger.client, grants.stranger],
      ["subscriber", subscriber.client, grants.subscriber],
      // The owner always rewinds their own recording.
      ["owner", live.owner.client, true],
    ];
    const got: [string, Start][] = [];
    for (const [who, viewer] of viewers) got.push([who, await start(viewer, live.owner.username)]);
    expect(got.map(([who, s]) => [who, s.dvrWindowSeconds > 0])).toEqual(viewers.map(([who, , g]) => [who, g]));
    for (const [, s] of got.filter(([, s]) => s.dvrWindowSeconds > 0)) await expectGranted(s, live);
    for (const [, s] of got.filter(([, s]) => s.dvrWindowSeconds === 0)) expectNone(s);
  });

  test("mature: only past the live gate, and then DVR follows the VOD", async () => {
    const live = await liveRecording();
    await db().update(schema.broadcasts).set({ mature: true }).where(eq(schema.broadcasts.id, live.broadcastId));
    expect((await startRaw(client(api), live.owner.username)).status).toBe(403);
    const adult = await signUpAndSignIn(api);
    await db()
      .update(schema.users)
      .set({ matureConfirmedAt: new Date(clock) })
      .where(eq(schema.users.id, adult.userId));
    await expectGranted(await start(adult.client, live.owner.username), live);
  });

  test("a T1-restricted broadcast gives no DVR, even to a confirmed adult", async () => {
    const live = await liveRecording();
    await db()
      .update(schema.broadcasts)
      .set({ restrictedAt: new Date(clock) })
      .where(eq(schema.broadcasts.id, live.broadcastId));
    const adult = await signUpAndSignIn(api);
    await db()
      .update(schema.users)
      .set({ matureConfirmedAt: new Date(clock) })
      .where(eq(schema.users.id, adult.userId));
    expectNone(await start(adult.client, live.owner.username));
    // The owner too (past the same gate as everyone): a restricted broadcast's VOD is hidden from them.
    await db()
      .update(schema.users)
      .set({ matureConfirmedAt: new Date(clock) })
      .where(eq(schema.users.id, live.owner.userId));
    expectNone(await start(live.owner.client, live.owner.username));
  });

  test("data mode: no DVR (source-only)", async () => {
    const live = await liveRecording();
    expectNone(await start(client(api), live.owner.username, { dataMode: dataModeCeilingBps(800) }));
  });

  test("VODs off: no DVR, even with a recording row", async () => {
    const live = await liveRecording({ vodEnabled: false });
    expectNone(await start(client(api), live.owner.username));
  });

  test("DVR off for the channel: no DVR", async () => {
    const live = await liveRecording();
    await db().update(schema.channels).set({ dvrEnabled: false }).where(eq(schema.channels.id, live.channelId));
    expectNone(await start(client(api), live.owner.username));
  });

  test("no recording VOD (not created yet, or already processing, or removed): no DVR", async () => {
    const live = await liveRecording();
    await db().update(schema.vods).set({ status: "processing" }).where(eq(schema.vods.id, live.vodId));
    expectNone(await start(client(api), live.owner.username));
    await db()
      .update(schema.vods)
      .set({ status: "recording", removedReason: "owner" })
      .where(eq(schema.vods.id, live.vodId));
    expectNone(await start(client(api), live.owner.username));
  });

  test("a rehearsal is never the live broadcast, so playback.start cannot grant it DVR", async () => {
    const live = await liveRecording();
    const rehearsal = uuidv7();
    await db()
      .insert(schema.broadcasts)
      .values({
        id: rehearsal,
        channelId: live.channelId,
        kind: "rehearsal",
        ingestProtocol: "rtmp",
        path: mediaPath(live.owner.username),
      });
    // Decision (f): the database refuses a rehearsal as `live_broadcast_id`.
    await expect(
      db().update(schema.channels).set({ liveBroadcastId: rehearsal }).where(eq(schema.channels.id, live.channelId)),
    ).rejects.toThrow("Failed query");
    await expectGranted(await start(client(api), live.owner.username), live);
  });

  test("a CDN-assigned session gets its DVR playlist on the origin (relay sessions: playback-dvr-relay.int.test.ts)", async () => {
    const live = await liveRecording({ viewers: 100 });
    Object.assign(env(), { CDN_PROVIDER: "origin-pull", CDN_BASE_URL: "https://cdn.example.invalid" });
    const cdn = await start(client(api), live.owner.username);
    expect(cdn.source).toBe("cdn");
    await expectGranted(cdn, live);
  });
});

describe("the DVR window", () => {
  test("min(channel window, DVR_MAX_WINDOW_SECONDS); a cap under 60 s turns DVR off", async () => {
    expect(dvrWindowSeconds(1800, 7200)).toBe(1800);
    expect(dvrWindowSeconds(7200, 600)).toBe(600);
    expect(dvrWindowSeconds(1800, 60)).toBe(60);
    expect(dvrWindowSeconds(1800, 59)).toBe(0);
    expect(dvrWindowSeconds(1800, 0)).toBe(0);

    const live = await liveRecording();
    await db().update(schema.channels).set({ dvrWindowSeconds: 3600 }).where(eq(schema.channels.id, live.channelId));
    await expectGranted(await start(client(api), live.owner.username), live, 3600);
    env().DVR_MAX_WINDOW_SECONDS = 900;
    await expectGranted(await start(client(api), live.owner.username), live, 900);
    env().DVR_MAX_WINDOW_SECONDS = 0;
    expectNone(await start(client(api), live.owner.username));
  });
});

describe("heartbeat: playback mode and the DVR token", () => {
  test("records playback_mode as claimed and credits dvr_seconds in dvr mode only", async () => {
    const live = await liveRecording();
    const viewer = client(api);
    const s = await start(viewer, live.owner.username);
    await beat(viewer, s.sessionId, s.token);
    expect(await sessionRow(s.sessionId)).toMatchObject({ playbackMode: "live", dvrSeconds: 0, watchSeconds: 10 });
    await beat(viewer, s.sessionId, s.token, { playbackMode: "dvr", behindLiveSeconds: 600 });
    expect(await sessionRow(s.sessionId)).toMatchObject({ playbackMode: "dvr", dvrSeconds: 10, watchSeconds: 20 });
    await beat(viewer, s.sessionId, s.token, { playbackMode: "dvr", behindLiveSeconds: 590 });
    await beat(viewer, s.sessionId, s.token, { playbackMode: "live" });
    expect(await sessionRow(s.sessionId)).toMatchObject({ playbackMode: "live", dvrSeconds: 20, watchSeconds: 40 });
    // Absent mode is live.
    await beat(viewer, s.sessionId, s.token, { playbackMode: "dvr" });
    await beat(viewer, s.sessionId, s.token);
    expect((await sessionRow(s.sessionId)).playbackMode).toBe("live");
  });

  test("a dvr claim without a grant is recorded as claimed (left to the fetch signal)", async () => {
    const live = await liveRecording({ visibility: "private" });
    const viewer = client(api);
    const s = await start(viewer, live.owner.username);
    expectNone(s);
    await beat(viewer, s.sessionId, s.token, { playbackMode: "dvr", behindLiveSeconds: 30 });
    expect(await sessionRow(s.sessionId)).toMatchObject({ playbackMode: "dvr", dvrSeconds: 10 });
  });

  test("the DVR token is refreshed beside the live one, bound to the same session", async () => {
    const live = await liveRecording();
    const viewer = client(api);
    const s = await start(viewer, live.owner.username);
    // Far from expiry: no new tokens.
    const early = await beat(viewer, s.sessionId, s.token);
    expect([early.token, early.dvrToken]).toEqual([undefined, undefined]);
    clock += (PLAYBACK_TOKEN_TTL_SECONDS - 60) * 1000;
    const r = await beat(viewer, s.sessionId, s.token, { playbackMode: "dvr", behindLiveSeconds: 120 });
    expect(r.token).toBeDefined();
    const claims = await claimsOf(r.dvrToken ?? "");
    expect(claims).toMatchObject({ sid: s.sessionId, path: dvrTokenPath(live.vodId), src: "origin" });
    expect(claims.exp).toBeGreaterThan((await claimsOf(tokenOfUrl(s.dvrPlaylistUrl ?? ""))).exp);
  });

  test("no DVR token without a grant, in data mode, or once the VOD stops admitting the viewer", async () => {
    const live = await liveRecording();
    const refreshed = async (viewer: Client, s: Start, extra: Record<string, unknown> = {}) => {
      clock += (PLAYBACK_TOKEN_TTL_SECONDS - 60) * 1000;
      return beat(viewer, s.sessionId, s.token, extra);
    };
    // Data mode at start: no grant at all.
    const dm = await start(client(api), live.owner.username, { dataMode: dataModeCeilingBps(800) });
    const dmBeat = await refreshed(client(api), dm);
    expect(dmBeat.token).toBeDefined();
    expect(dmBeat.dvrToken).toBeUndefined();

    // Data mode turned on mid-session: the live token re-mints, the DVR token does not.
    const viewer = client(api);
    const s = await start(viewer, live.owner.username);
    const on = await beat(viewer, s.sessionId, s.token, { dataMode: dataModeCeilingBps(800) });
    expect(on.token).toBeDefined();
    expect(on.dvrToken).toBeUndefined();
    // And off again: DVR comes back with the re-mint.
    const off = await beat(viewer, s.sessionId, on.token ?? "", { dataMode: null });
    expect((await claimsOf(off.dvrToken ?? "")).path).toBe(dvrTokenPath(live.vodId));

    // The owner makes the recording private: a stranger's next refresh carries no DVR token.
    const watcher = await start(stranger.client, live.owner.username);
    await expectGranted(watcher, live);
    await db().update(schema.vods).set({ visibility: "private" }).where(eq(schema.vods.id, live.vodId));
    const after = await refreshed(stranger.client, watcher);
    expect(after.token).toBeDefined();
    expect(after.dvrToken).toBeUndefined();
    // The owner still gets one.
    const own = await start(live.owner.client, live.owner.username);
    expect((await claimsOf((await refreshed(live.owner.client, own)).dvrToken ?? "")).path).toBe(
      dvrTokenPath(live.vodId),
    );
  });

  test("ending the session drops the grant", async () => {
    const live = await liveRecording();
    const viewer = client(api);
    const s = await start(viewer, live.owner.username);
    expect(await api.deps.valkey.get(`playback-dvr:${s.sessionId}`)).toBe(live.vodId);
    const end = await viewer.call("POST", "/api/playback/end", { sessionId: s.sessionId, token: s.token });
    expect(end.status).toBe(200);
    expect(await api.deps.valkey.get(`playback-dvr:${s.sessionId}`)).toBeNull();
  });
});
