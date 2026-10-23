// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { expectedPlaybackPath } from "../src/browser-viewer.ts";

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
