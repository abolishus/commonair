// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { expectedPlaybackPath, playerState } from "../src/browser-viewer.ts";
import { emptyReport } from "../src/viewer.ts";

// CI's first full harness run failed ingest-rtmp and ingest-whip on "webkit: playback path
// {"path":"mse"}": the scenarios assumed WebKit always plays HLS natively, which holds only on macOS.
describe("expectedPlaybackPath", () => {
  test("WebKit with native HLS (macOS, as Safari and iOS) plays natively", () => {
    expect(expectedPlaybackPath("webkit", true)).toBe("native");
  });

  test("WebKit without an HLS backend (Playwright on Linux) falls back to hls.js over MSE", () => {
    expect(expectedPlaybackPath("webkit", false)).toBe("mse");
  });

  test("Chromium always uses hls.js, even where its video element claims HLS", () => {
    expect(expectedPlaybackPath("chromium", false)).toBe("mse");
    expect(expectedPlaybackPath("chromium", true)).toBe("mse");
  });
});

// CI's ingest-whip once timed out on Chromium's first frame with no player errors, which said
// nothing about how far playback got.
describe("playerState", () => {
  test("names the player's last errors when it has any", () => {
    const r = { ...emptyReport("c", "browser", "chromium"), errors: ["a", "b", "hls.js: x", "d"] };
    expect(playerState(r)).toBe("player errors: b | hls.js: x | d");
  });

  test("else says how far it got: session, source, bytes", () => {
    const r = { ...emptyReport("c", "browser", "chromium"), playbackPath: "mse" as const, sessionId: "s1" };
    expect(playerState({ ...r, source: "origin", bytesHttp: 0 })).toBe(
      "no player errors; path=mse session=yes source=origin bytes=0 stalls=0 heartbeats=0",
    );
    expect(playerState(emptyReport("c", "browser", "webkit"))).toContain("path=none session=none source=none");
  });
});
