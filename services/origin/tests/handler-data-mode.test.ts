// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ADR 0018 decision 5 at the handler: a `dm` token's multivariant playlist is always synthesized,
 * filtered for the budget and never stored; everything else is unchanged.
 */
import { describe, expect, test } from "vite-plus/test";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import type { Executor } from "@commonair/db";
import { generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import type { SegmentLog } from "../src/accounting.ts";
import type { RelayAuth } from "../src/auth.ts";
import type { ChannelDirectory } from "../src/channels.ts";
import type { ContentStore, MediaObject, ObjectRef } from "../src/content.ts";
import { createHandler } from "../src/handler.ts";
import { AUDIO_ONLY_BANDWIDTH } from "../src/playlist.ts";
import { TokenRefresher } from "../src/refresh.ts";
import { MEDIA, MULTIVARIANT, rendition480, rendition720 } from "./fixtures.ts";

const { key } = await generateSigningKey();
const NOW = Math.floor(Date.now() / 1000);
const CHANNEL = { id: "0190a0a0-0000-7000-8000-000000000002", slug: "alice", broadcastId: "b" };
const enc = new TextEncoder();

const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims =>
  ({
    v: 1,
    sid: "0190a0a0-0000-7000-8000-000000000001",
    cid: CHANNEL.id,
    path: "live/alice",
    src: "origin",
    iat: NOW - 10,
    exp: NOW + 110,
    ...over,
  }) as PlaybackClaims;

const playlists: Record<string, string> = {
  "live/alice/index.m3u8": MULTIVARIANT,
  "live/alice/720p/index.m3u8": rendition720,
  "live/alice/480p/index.m3u8": rendition480,
  "live/alice/480p/video1_stream.m3u8": MEDIA,
};

function handler(renditions: string[]) {
  const store = {
    checkBlocking: async () => "ok",
    get: async (ref: ObjectRef): Promise<MediaObject> => {
      const text = playlists[`${ref.upstreamPath}/${ref.file}`];
      const body = enc.encode(text ?? "");
      return {
        status: text === undefined ? 404 : 200,
        body,
        contentType: "application/vnd.apple.mpegurl",
        size: body.byteLength,
      };
    },
  } as unknown as ContentStore;
  const channels = {
    lookup: async (slug: string) => (slug === CHANNEL.slug ? CHANNEL : null),
    renditions: async () => renditions,
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

async function get(renditions: string[], path: string, c: PlaybackClaims) {
  const t = await signPlaybackToken(key, c);
  const res = await handler(renditions)(new Request(`http://origin.test/hls/${path}?t=${encodeURIComponent(t)}`));
  return { res, text: await res.text() };
}

const bandwidths = (text: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("#EXT-X-STREAM-INF:"))
    .map((l) => Number(/BANDWIDTH=(\d+)/.exec(l)?.[1]));

describe("multivariant playlist for data-mode tokens", () => {
  test("filtered by the ceiling and never stored", async () => {
    const { res, text } = await get(["720p", "480p"], "live/alice/index.m3u8", claims({ dm: 1_000_000 }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(bandwidths(text)).toEqual([800_000, AUDIO_ONLY_BANDWIDTH]);
  });

  test("without dm the full ladder is served as before, no-cache", async () => {
    const { res, text } = await get(["720p", "480p"], "live/alice/index.m3u8", claims());
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(bandwidths(text)).toEqual([2_117_768, 1_400_000, 800_000, AUDIO_ONLY_BANDWIDTH]);
  });

  test("a source-only channel gets a derived audio-only variant only for dm tokens", async () => {
    const dm = await get([], "live/alice/index.m3u8", claims({ dm: 96_618 }));
    expect(bandwidths(dm.text)).toEqual([AUDIO_ONLY_BANDWIDTH]);
    expect(dm.res.headers.get("cache-control")).toBe("private, no-store");

    const plain = await get([], "live/alice/index.m3u8", claims());
    // Unchanged: MediaMTX's own playlist, rewritten (no derived variant).
    expect(bandwidths(plain.text)).toEqual([2_117_768]);
    expect(plain.text).toContain('GROUP-ID="audio"');
  });

  test("a rendition whose playlist is missing falls back to the source alone, still filtered", async () => {
    const { text } = await get(["1080p"], "live/alice/index.m3u8", claims({ dm: 96_618 }));
    expect(bandwidths(text)).toEqual([AUDIO_ONLY_BANDWIDTH]);
  });

  test("media playlists of a filtered-out rendition are still served, without the LL-HLS layer", async () => {
    const { res, text } = await get(["720p", "480p"], "live/alice/480p/video1_stream.m3u8", claims({ dm: 96_618 }));
    expect(res.status).toBe(200);
    expect(text).not.toContain("#EXT-X-PART");
    expect(text).not.toContain("#EXT-X-SERVER-CONTROL");
    expect(text).toContain("54dd20fd99ec_video1_seg35.mp4?t=");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("without dm a media playlist keeps its parts", async () => {
    const { text } = await get(["720p", "480p"], "live/alice/480p/video1_stream.m3u8", claims());
    expect(text).toContain("#EXT-X-PART-INF");
    expect(text).toContain("#EXT-X-PRELOAD-HINT");
  });

  test("filtered URIs still carry the viewer's token exactly once", async () => {
    const c = claims({ dm: 1_000_000 });
    const t = await signPlaybackToken(key, c);
    const res = await handler(["720p", "480p"])(
      new Request(`http://origin.test/hls/live/alice/index.m3u8?t=${encodeURIComponent(t)}`),
    );
    const uris = (await res.text()).split("\n").filter((l) => l !== "" && !l.startsWith("#"));
    expect(uris.length).toBe(2);
    for (const u of uris) {
      expect(new URL(u, "http://x/").searchParams.getAll("t")).toEqual([t]);
      expect(u).not.toContain("session=");
    }
  });
});
