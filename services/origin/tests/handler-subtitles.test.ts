// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 decision (y) at the handler: the multivariant advertises SUBTITLES wherever the `.vtt`
 * route serves them. A viewer's own origin token and member relays (which neither count nor pin
 * `.vtt`) get the group; a rehearsal invitee (`rb`), a CDN-sourced token with a CDN base and a
 * CDN origin-pull do not.
 */
import { describe, expect, test } from "vite-plus/test";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Executor } from "@commonair/db";
import { generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import type { SegmentLog } from "../src/accounting.ts";
import type { RelayAuth } from "../src/auth.ts";
import type { ChannelDirectory } from "../src/channels.ts";
import type { ContentStore, MediaObject } from "../src/content.ts";
import { createHandler } from "../src/handler.ts";
import { TokenRefresher } from "../src/refresh.ts";
import { MULTIVARIANT } from "./fixtures.ts";

const { key } = await generateSigningKey();
const NOW = Math.floor(Date.now() / 1000);
const CHANNEL_ID = "0190a0a0-0000-7000-8000-000000000002";
const BROADCAST = "0190a0a0-0000-7000-8000-00000000000c";
const REHEARSAL = "0190a0a0-0000-7000-8000-00000000000b";
const RELAY_ID = "0190a0a0-0000-7000-8000-000000000003";
const RELAY_HEADER = `Bearer relay_${"A".repeat(43)}`;
const CDN_AUTH = "cdn-secret";
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

const handler = createHandler({
  publicKey: key.publicKey,
  store: {
    checkBlocking: async () => "ok",
    get: async (): Promise<MediaObject> => {
      const body = enc.encode(MULTIVARIANT);
      return { status: 200, body, contentType: "application/vnd.apple.mpegurl", size: body.byteLength };
    },
  } as unknown as ContentStore,
  channels: {
    lookup: async (slug: string) => (slug === "alice" ? { id: CHANNEL_ID, slug, broadcastId: BROADCAST } : null),
    lookupRehearsal: async (slug: string, broadcastId: string) =>
      slug === "alice" && broadcastId === REHEARSAL ? { id: CHANNEL_ID, slug, broadcastId } : null,
    renditions: async () => [],
    sourceAac: async () => "off",
  } as unknown as ChannelDirectory,
  relays: {
    authenticate: async (h: string | null) => (h === RELAY_HEADER ? { id: RELAY_ID } : null),
  } as unknown as RelayAuth,
  segments: { record: () => {} } as unknown as SegmentLog,
  refresher: new TokenRefresher({
    key,
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ endedAt: null }] }) }) }),
    } as unknown as Executor,
    now: () => NOW,
  }),
  cdn: { enabled: true, baseUrl: "https://cdn.example.invalid", authValue: CDN_AUTH },
  subtitles: async () => [{ language: "en" }],
});

async function body(path: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await handler(new Request(`http://origin.test${path}`, { headers }));
  expect(res.status).toBe(200);
  return res.text();
}
const viewer = async (c: PlaybackClaims) =>
  body(`/hls/live/alice/index.m3u8?t=${encodeURIComponent(await signPlaybackToken(key, c))}`);
const hasSubtitles = (text: string) => text.includes("TYPE=SUBTITLES");

describe("SUBTITLES on the multivariant (decision (y))", () => {
  test("a viewer's origin token gets the group", async () => {
    expect(hasSubtitles(await viewer(claims()))).toBe(true);
  });

  test("a member relay's pull gets the group", async () => {
    const text = await body("/relay-pull/live/alice/index.m3u8", { authorization: RELAY_HEADER });
    expect(hasSubtitles(text)).toBe(true);
    expect(text).toContain('URI="captions/en/index.m3u8"');
  });

  test("a rehearsal invitee, a CDN-sourced token and a CDN pull do not", async () => {
    expect(hasSubtitles(await viewer(claims({ rb: REHEARSAL })))).toBe(false);
    expect(hasSubtitles(await viewer(claims({ src: "cdn" })))).toBe(false);
    expect(hasSubtitles(await body("/cdn/live/alice/index.m3u8", { "x-cdn-auth": CDN_AUTH }))).toBe(false);
  });
});
