// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { PlaybackClaims } from "@commonair/contracts/tokens";
import { generateSigningKey, signPlaybackToken } from "@commonair/tokens";
import { authorizeViewer, cdnAuthValue, checkCdnAuth } from "../src/auth.ts";
import { parseMediaPath, type MediaRequest } from "../src/paths.ts";

const { key } = await generateSigningKey();
const { key: otherKey } = await generateSigningKey();
const now = 1_800_000_000;
const claims = (over: Partial<PlaybackClaims> = {}): PlaybackClaims =>
  ({
    v: 1,
    sid: "0190a0a0-0000-7000-8000-000000000001",
    cid: "0190a0a0-0000-7000-8000-000000000002",
    path: "live/alice",
    src: "origin",
    iat: now - 10,
    exp: now + 110,
    ...over,
  }) as PlaybackClaims;
const req = (p: string) => parseMediaPath(p) as MediaRequest;

describe("authorizeViewer", () => {
  test("accepts a valid origin token for any file of the channel, including renditions", async () => {
    const t = await signPlaybackToken(key, claims());
    for (const p of ["/hls/live/alice/index.m3u8", "/hls/live/alice/720p/x_seg1.mp4"]) {
      const r = await authorizeViewer(key.publicKey, t, req(p), now);
      expect(r).toMatchObject({ ok: true, token: t, claims: { path: "live/alice" } });
    }
  });

  test("a data-mode token passes through with its dm claim unchanged (ADR 0018)", async () => {
    const t = await signPlaybackToken(key, claims({ dm: 96_618 }));
    const r = await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now);
    expect(r).toMatchObject({ ok: true, claims: { dm: 96_618, src: "origin" } });
    // Media playlists and segments of any rendition are never refused by rendition.
    const seg = await authorizeViewer(key.publicKey, t, req("/hls/live/alice/1080p/x_seg1.mp4"), now);
    expect(seg.ok).toBe(true);
  });

  test("accepts cdn-delivered sessions", async () => {
    const t = await signPlaybackToken(key, claims({ src: "cdn" }));
    expect((await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now)).ok).toBe(true);
  });

  test.each([
    ["missing", null],
    ["malformed", "nope"],
  ])("rejects %s tokens", async (reason, t) => {
    expect(await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now)).toEqual({
      ok: false,
      reason,
    });
  });

  test("rejects a token signed by another key", async () => {
    const t = await signPlaybackToken(otherKey, claims());
    expect(await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  test("rejects expired tokens (beyond clock skew)", async () => {
    const t = await signPlaybackToken(key, claims({ iat: now - 500, exp: now - 31 }));
    expect(await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  test("rejects a token for another channel's path", async () => {
    const t = await signPlaybackToken(key, claims({ path: "live/bob" }));
    expect(await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now)).toEqual({
      ok: false,
      reason: "wrong_path",
    });
  });

  test.each(["relay", "p2p"] as const)("rejects src=%s at the origin's viewer route", async (src) => {
    const t = await signPlaybackToken(
      key,
      claims(src === "relay" ? { src, rid: "0190a0a0-0000-7000-8000-000000000009" } : { src }),
    );
    expect(await authorizeViewer(key.publicKey, t, req("/hls/live/alice/index.m3u8"), now)).toEqual({
      ok: false,
      reason: "wrong_source",
    });
  });
});

describe("CDN origin-pull auth", () => {
  test("HMAC of the internal secret, compared case-insensitively and in constant time", async () => {
    const v = await cdnAuthValue("x".repeat(32));
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(v).not.toBe(await cdnAuthValue("y".repeat(32)));
    expect(checkCdnAuth(v, v)).toBe(true);
    expect(checkCdnAuth(v, ` ${v.toUpperCase()} `)).toBe(true);
    expect(checkCdnAuth(v, null)).toBe(false);
    expect(checkCdnAuth(v, v.slice(1))).toBe(false);
  });
});
