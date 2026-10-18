// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { analyzeProbe, parseRate } from "../src/ffmpeg/probe.ts";
import live720 from "./fixtures/ffprobe-rtmp-720p30-gop2.json" with { type: "json" };
import gop4 from "./fixtures/ffprobe-1080p60-gop4-bframes.json" with { type: "json" };
import fpsDrop from "./fixtures/ffprobe-480p-fpsdrop-noaudio.json" with { type: "json" };

describe("analyzeProbe", () => {
  test("live RTMP source over RTSP: 720p30, 2 s keyframes, AAC, no B-frames", () => {
    const r = analyzeProbe(live720);
    expect(r.videoCodec).toBe("h264");
    expect(r.audioCodec).toBe("aac");
    expect([r.width, r.height]).toEqual([1280, 720]);
    expect(r.nominalFps).toBe(30);
    expect(r.measuredFps).toBeGreaterThan(29);
    expect(r.measuredFps).toBeLessThan(31);
    expect(r.keyframeCount).toBe(2);
    // Keyframe packets at 1.633 s and 3.645 s.
    expect(r.keyframeIntervalMs).toBe(2012);
    expect(r.hasBFrames).toBe(false);
  });

  test("4 s GOP: one keyframe in the window means no measurable interval", () => {
    const r = analyzeProbe(gop4);
    expect(r.keyframeCount).toBe(1);
    expect(r.keyframeIntervalMs).toBeNull();
    expect(r.windowSeconds).toBeGreaterThanOrEqual(3.9);
    expect([r.width, r.height]).toEqual([1920, 1080]);
    expect(r.nominalFps).toBe(60);
  });

  test("B-frames are detected", () => {
    expect(analyzeProbe(gop4).hasBFrames).toBe(true);
  });

  test("declared 30 fps, delivered 20 fps, no audio", () => {
    const r = analyzeProbe(fpsDrop);
    expect(r.nominalFps).toBe(30);
    expect(r.measuredFps).toBe(20);
    expect(r.audioCodec).toBeNull();
    expect(r.keyframeIntervalMs).toBe(2000);
  });

  test("B-frames are detected from reordered timestamps even if the header says none", () => {
    const packets = [0, 0.1, 0.0333, 0.0666, 0.2].map((t, i) => ({
      stream_index: 0,
      pts_time: t.toFixed(4),
      flags: i === 0 ? "K__" : "___",
    }));
    const r = analyzeProbe({
      streams: [{ index: 0, codec_type: "video", codec_name: "h264", has_b_frames: 0 }],
      packets,
    });
    expect(r.hasBFrames).toBe(true);
  });

  test("an empty probe (nothing arrived) yields nulls, not errors", () => {
    const r = analyzeProbe({ streams: [], packets: [] });
    expect(r).toMatchObject({
      videoCodec: null,
      audioCodec: null,
      measuredFps: null,
      keyframeIntervalMs: null,
      keyframeCount: 0,
      windowSeconds: 0,
    });
  });

  test("rejects output that is not ffprobe JSON", () => {
    expect(() => analyzeProbe({ streams: "nope" })).toThrow(/expected array/i);
  });
});

describe("parseRate", () => {
  test("fractions, integers and invalid values", () => {
    expect(parseRate("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRate("60/1")).toBe(60);
    expect(parseRate("25")).toBe(25);
    expect(parseRate("0/0")).toBeNull();
    expect(parseRate("30/0")).toBeNull();
    expect(parseRate(undefined)).toBeNull();
  });
});
