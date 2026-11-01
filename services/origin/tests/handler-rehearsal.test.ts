// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 6 decision (f) at the handler: a rehearsal invitee's token (`rb`) plays that open
 * rehearsal on `live/<slug>`; a token without `rb` never does, and an `rb` token never plays the
 * live broadcast.
 */
import { describe, expect, test } from "vite-plus/test";
import { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Executor } from "@commonair/db";
import { generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import type { SegmentLog } from "../src/accounting.ts";
import type { RelayAuth } from "../src/auth.ts";
import type { ChannelDirectory, LiveChannel } from "../src/channels.ts";
import type { ContentStore, MediaObject } from "../src/content.ts";
import { createHandler } from "../src/handler.ts";
import { TokenRefresher } from "../src/refresh.ts";
import { MULTIVARIANT } from "./fixtures.ts";

const { key } = await generateSigningKey();
const NOW = Math.floor(Date.now() / 1000);
const CHANNEL_ID = "0190a0a0-0000-7000-8000-000000000002";
const REHEARSAL = "0190a0a0-0000-7000-8000-00000000000b";
const enc = new TextEncoder();

const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims =>
  ({
    v: 1,
    sid: "0190a0a0-0000-7000-8000-000000000001",
    cid: CHANNEL_ID,
    path: "live/alice",
    src: "origin",
    iat: NOW - 10,
    exp: NOW + 110,
    ...over,
  }) as PlaybackClaims;

function handler(live: LiveChannel | null) {
  const store = {
    checkBlocking: async () => "ok",
    get: async (): Promise<MediaObject> => {
      const body = enc.encode(MULTIVARIANT);
      return { status: 200, body, contentType: "application/vnd.apple.mpegurl", size: body.byteLength };
    },
  } as unknown as ContentStore;
  const channels = {
    lookup: async (slug: string) => (slug === "alice" ? live : null),
    lookupRehearsal: async (slug: string, broadcastId: string) =>
      slug === "alice" && broadcastId === REHEARSAL ? { id: CHANNEL_ID, slug, broadcastId } : null,
    renditions: async () => [],
    sourceAac: async () => "off",
  } as unknown as ChannelDirectory;
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ endedAt: null }] }) }) }) };
  return createHandler({
    publicKey: key.publicKey,
    store,
    channels,
    relays: {} as RelayAuth,
    segments: { record: () => {} } as unknown as SegmentLog,
    refresher: new TokenRefresher({ key, db: db as unknown as Executor, now: () => NOW }),
    cdn: { enabled: false, authValue: "" },
  });
}

async function status(live: LiveChannel | null, c: PlaybackClaims) {
  const t = await signPlaybackToken(key, c);
  const res = await handler(live)(
    new Request(`http://origin.test/hls/live/alice/index.m3u8?t=${encodeURIComponent(t)}`),
  );
  await res.body?.cancel();
  return res.status;
}

describe("rehearsal playback (decision (f))", () => {
  test("an invitee's token plays the open rehearsal it names", async () => {
    expect(await status(null, claims({ rb: REHEARSAL }))).toBe(200);
  });

  test("a token without rb sees a rehearsing channel as offline", async () => {
    expect(await status(null, claims())).toBe(404);
  });

  test("an rb token for another or ended rehearsal is offline, even while the channel is live", async () => {
    const live = { id: CHANNEL_ID, slug: "alice", broadcastId: "0190a0a0-0000-7000-8000-00000000000c" };
    expect(await status(live, claims({ rb: "0190a0a0-0000-7000-8000-00000000000d" }))).toBe(404);
  });

  test("rb is only for origin tokens on a live path", () => {
    expect(PlaybackClaims.safeParse(claims({ rb: REHEARSAL })).success).toBe(true);
    expect(
      PlaybackClaims.safeParse(claims({ rb: REHEARSAL, src: "relay", rid: "0190a0a0-0000-7000-8000-000000000003" }))
        .success,
    ).toBe(false);
    expect(PlaybackClaims.safeParse(claims({ rb: REHEARSAL, src: "cdn" })).success).toBe(false);
    expect(PlaybackClaims.safeParse(claims({ rb: REHEARSAL, path: "vod/x" })).success).toBe(false);
  });
});
