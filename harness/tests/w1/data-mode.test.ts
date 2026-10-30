// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure parts of the `integrity-basic` `data-mode` extension (W1-data-mode). */
import { describe, expect, test } from "vite-plus/test";
import {
  AUDIO_CEILING_BPS,
  DEFAULT_THROTTLE_KBPS,
  METER_TOLERANCE,
  isVideoMediaUrl,
  meterWithinEstimate,
  throttleConditions,
} from "../../src/w1/data-mode.ts";

describe("the Audio preset", () => {
  test("50 MB an hour is a ~97 kbit/s ceiling (contract step §8.3)", () => {
    expect(AUDIO_CEILING_BPS).toBe(96_618);
  });
});

describe("throttleConditions", () => {
  test("kilobit/s to CDP's bytes per second, both ways", () => {
    expect(throttleConditions(64)).toEqual({
      offline: false,
      latency: 150,
      downloadThroughput: 8_000,
      uploadThroughput: 8_000,
    });
    expect(throttleConditions(DEFAULT_THROTTLE_KBPS).downloadThroughput).toBe(32_000);
  });

  test("never zero (CDP reads 0 as unthrottled)", () => {
    expect(throttleConditions(0).downloadThroughput).toBe(1);
  });

  test("the default fits the scenario's 160 kbit/s audio with room for playlists", () => {
    expect(DEFAULT_THROTTLE_KBPS * 1000).toBeGreaterThan(160_000 * 1.3);
  });
});

describe("isVideoMediaUrl", () => {
  const base = "https://play.example/hls/live/alice";
  test("video segments, parts and init sections, and anything in a video rung", () => {
    for (const u of [
      `${base}/54dd20fd99ec_video1_seg33.mp4?t=x`,
      `${base}/54dd20fd99ec_video1_part155.mp4?t=x`,
      `${base}/54dd20fd99ec_video1_init.mp4`,
      `${base}/480p/abc_audio2_seg3.mp4`,
      `${base}/720p/x.m4s`,
      `${base}/1080p/seg.ts`,
    ])
      expect(isVideoMediaUrl(u), u).toBe(true);
  });

  test("audio media, playlists and other URLs are not video", () => {
    for (const u of [
      `${base}/54dd20fd99ec_audio2_seg33.mp4?t=x`,
      `${base}/audio/abc_audio1_part4.mp4`,
      `${base}/video1_stream.m3u8?t=x`,
      `${base}/index.m3u8`,
      "https://web.example/assets/video_player.js",
      "not a url",
    ])
      expect(isVideoMediaUrl(u), u).toBe(false);
  });
});

describe("meterWithinEstimate", () => {
  test(`up to the estimate + ${METER_TOLERANCE * 100} %`, () => {
    expect(meterWithinEstimate(99, 99)).toBe(true);
    expect(meterWithinEstimate(118.8, 99)).toBe(true);
    expect(meterWithinEstimate(119, 99)).toBe(false);
    expect(meterWithinEstimate(0, 50)).toBe(true);
  });

  test("no estimate or an unreadable number fails", () => {
    expect(meterWithinEstimate(10, 0)).toBe(false);
    expect(meterWithinEstimate(Number.NaN, 50)).toBe(false);
    expect(meterWithinEstimate(10, Number.NaN)).toBe(false);
  });
});
