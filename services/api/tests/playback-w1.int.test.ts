// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W1 contract step (ADR 0015 decision 2, ADR 0018): `playback.start` keeps a signed-in viewer of
 * a gated or surging channel off the CDN; anonymous viewers may still be served from it.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER, KEYS, mediaPath } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type Client, type TestApi } from "./harness.ts";

let api: TestApi;

type Start = { source: string; dataMode: number | null };
type MutableEnv = {
  CDN_PROVIDER: "none" | "origin-pull";
  CDN_BASE_URL: string | undefined;
  CDN_BURST_VIEWER_THRESHOLD: number;
  CHAT_WATCH_GATE: "off" | "on";
  CHAT_SURGE_GUARD: "off" | "on";
};
const env = () => api.deps.env as unknown as MutableEnv;

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
  // Above the CDN burst threshold (10, below): the cached public count is what assignment reads.
  await api.deps.valkey.set(KEYS.viewerCount(c.id), "100", "EX", 600);
  return { ...s, channelId: c.id };
}

async function start(viewer: Client, slug: string): Promise<Start> {
  const res = await viewer.call<Start>("POST", `/api/channels/${slug}/playback`, {
    deviceId: "device-0123456789abcdef",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function gate(channelId: string, minVerifiedWatchSeconds: number) {
  await api.db.db
    .update(schema.channels)
    .set({ chatSettings: ChannelChatSettings.parse({ minVerifiedWatchSeconds }) })
    .where(eq(schema.channels.id, channelId));
}

const surge = (channelId: string, value: string) =>
  api.deps.valkey.set(KEYS.surgeOverride(channelId), value, "EX", 600);
const surgeOn = () =>
  JSON.stringify({
    state: "on",
    since: new Date().toISOString(),
    until: new Date(Date.now() + 600_000).toISOString(),
    by: null,
  });

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  await api?.stop();
});
beforeEach(() => {
  Object.assign(env(), {
    CDN_PROVIDER: "origin-pull",
    CDN_BASE_URL: "https://cdn.example.invalid",
    CDN_BURST_VIEWER_THRESHOLD: 10,
    CHAT_WATCH_GATE: "off",
    CHAT_SURGE_GUARD: "off",
  } satisfies MutableEnv);
});

describe("playback.start avoidCdn (W1)", () => {
  test("a channel with neither the gate nor surge mode: everyone may be on the CDN; dataMode is null", async () => {
    const st = await liveStreamer();
    const viewer = await signUpAndSignIn(api);
    expect(await start(viewer.client, st.username)).toMatchObject({ source: "cdn", dataMode: null });
    expect(await start(client(api), st.username)).toMatchObject({ source: "cdn", dataMode: null });
  });

  test("a gated channel above the CDN threshold: signed-in viewers are not on the CDN, anonymous ones may be", async () => {
    const st = await liveStreamer();
    await gate(st.channelId, 120);
    env().CHAT_WATCH_GATE = "on";
    const viewer = await signUpAndSignIn(api);
    expect((await start(viewer.client, st.username)).source).toBe("origin");
    expect((await start(client(api), st.username)).source).toBe("cdn");
  });

  test("the channel's gate setting does nothing while CHAT_WATCH_GATE is off", async () => {
    const st = await liveStreamer();
    await gate(st.channelId, 120);
    const viewer = await signUpAndSignIn(api);
    expect((await start(viewer.client, st.username)).source).toBe("cdn");
  });

  test("surge mode on: signed-in viewers avoid the CDN, only while CHAT_SURGE_GUARD is on", async () => {
    const st = await liveStreamer();
    await surge(st.channelId, surgeOn());
    const viewer = await signUpAndSignIn(api);
    expect((await start(viewer.client, st.username)).source).toBe("cdn");
    env().CHAT_SURGE_GUARD = "on";
    expect((await start(viewer.client, st.username)).source).toBe("origin");
    expect((await start(client(api), st.username)).source).toBe("cdn");
  });

  test("a suppressed or unreadable override is not surge mode (fail toward serving)", async () => {
    const st = await liveStreamer();
    env().CHAT_SURGE_GUARD = "on";
    const viewer = await signUpAndSignIn(api);
    await surge(st.channelId, JSON.stringify({ ...JSON.parse(surgeOn()), state: "suppressed" }));
    expect((await start(viewer.client, st.username)).source).toBe("cdn");
    await surge(st.channelId, "{not json");
    expect((await start(viewer.client, st.username)).source).toBe("cdn");
  });
});
