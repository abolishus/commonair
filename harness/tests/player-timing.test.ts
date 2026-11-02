// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { harnessPlayerUrl } from "../src/browser-viewer.ts";
import { HUMAN_TIMING, nextHeartbeatDelay, timingFromParams } from "../src/fingerprint.ts";
import { STEADY_TIMING, VIEWER_WINDOW_MS } from "../src/integrity-viewers.ts";

const BASE = "http://127.0.0.1:4100";
const target = { channel: "alice" };
const params = (url: string) => new URL(url).searchParams;

// integrity-basic CI run 41454708125: the Chromium harness player beat on HUMAN_TIMING whatever the
// scenario asked, so one late beat (36.8 s since the last) dropped it out of the 30 s public count.
describe("harness player heartbeat timing", () => {
  test("a page opened with a timing beats on it", () => {
    const url = harnessPlayerUrl(BASE, target, { count: 1, native: "auto", timing: STEADY_TIMING });
    expect(timingFromParams(params(url))).toEqual(STEADY_TIMING);
  });

  test("a page opened without one keeps the human default", () => {
    const url = harnessPlayerUrl(BASE, target, { count: 1, native: "auto" });
    expect(params(url).has("late")).toBe(false);
    expect(timingFromParams(params(url))).toEqual(HUMAN_TIMING);
  });

  test("malformed or out-of-range values fall back per field", () => {
    expect(timingFromParams(new URLSearchParams("jitter=abc&late=0"))).toEqual({
      jitter: HUMAN_TIMING.jitter,
      lateProbability: 0,
    });
    expect(timingFromParams(new URLSearchParams("jitter=0.1&late=2"))).toEqual({
      jitter: 0.1,
      lateProbability: HUMAN_TIMING.lateProbability,
    });
    expect(timingFromParams(new URLSearchParams("jitter=-1&late="))).toEqual(HUMAN_TIMING);
  });

  test("steady timing never leaves a gap as long as the count window", () => {
    const url = harnessPlayerUrl(BASE, target, { count: 1, native: "auto", timing: STEADY_TIMING });
    const timing = timingFromParams(params(url));
    // Worst case: the random source at both extremes, including the late branch's draw.
    for (const r of [0, 0.5, 0.999999]) {
      expect(nextHeartbeatDelay(10_000, timing, () => r)).toBeLessThan(VIEWER_WINDOW_MS);
    }
  });

  test("human timing can (this is what failed): a late beat exceeds the window", () => {
    // jitter draw high, late branch taken, late draw high: 11.5 s + 30 s.
    const draws = [0.999, 0, 0.999];
    let i = 0;
    expect(nextHeartbeatDelay(10_000, HUMAN_TIMING, () => draws[i++] ?? 0)).toBeGreaterThan(VIEWER_WINDOW_MS);
  });
});
