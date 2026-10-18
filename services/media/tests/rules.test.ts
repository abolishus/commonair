// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ProbeResult } from "../src/ffmpeg/probe.ts";
import {
  bitrateKbps,
  droppedFrames,
  fpsDeficit,
  healthWarnings,
  minBitrateKbps,
  WARNINGS,
} from "../src/health/rules.ts";

const good: ProbeResult = {
  videoCodec: "h264",
  audioCodec: "aac",
  width: 1920,
  height: 1080,
  nominalFps: 60,
  measuredFps: 60,
  keyframeIntervalMs: 2000,
  keyframeCount: 3,
  windowSeconds: 4,
  hasBFrames: false,
};
const rtmp = "rtmpConn";
const whip = "webRTCSession";

describe("healthWarnings", () => {
  test("a healthy stream has no warnings", () => {
    expect(healthWarnings({ bitrateKbps: 6000, sourceType: rtmp, probe: good })).toEqual([]);
  });

  test("bitrate bounds", () => {
    expect(healthWarnings({ bitrateKbps: 8001, sourceType: rtmp, probe: good })).toEqual([WARNINGS.bitrateHigh]);
    expect(healthWarnings({ bitrateKbps: 8000, sourceType: rtmp, probe: good })).toEqual([]);
    expect(healthWarnings({ bitrateKbps: 999, sourceType: rtmp, probe: good })).toEqual([WARNINGS.bitrateLow]);
    expect(healthWarnings({ bitrateKbps: 0, sourceType: rtmp, probe: null })).toEqual([WARNINGS.bitrateLow]);
  });

  test("the low-bitrate floor depends on resolution", () => {
    const p360 = { ...good, height: 360, width: 640 };
    expect(healthWarnings({ bitrateKbps: 500, sourceType: rtmp, probe: p360 })).toEqual([]);
    expect(healthWarnings({ bitrateKbps: 500, sourceType: rtmp, probe: good })).toEqual([WARNINGS.bitrateLow]);
    expect(minBitrateKbps(null)).toBe(1000);
    expect(minBitrateKbps(480)).toBe(600);
    expect(minBitrateKbps(240)).toBe(300);
  });

  test("keyframe interval must be 2 s ± 0.5 s", () => {
    const at = (ms: number | null, windowSeconds = 4) =>
      healthWarnings({
        bitrateKbps: 6000,
        sourceType: rtmp,
        probe: { ...good, keyframeIntervalMs: ms, windowSeconds },
      });
    expect(at(2500)).toEqual([]);
    expect(at(1500)).toEqual([]);
    expect(at(2501)).toEqual([WARNINGS.keyframeInterval]);
    expect(at(1000)).toEqual([WARNINGS.keyframeInterval]);
    // Only one keyframe in a 4 s window: the interval is > 2.5 s.
    expect(at(null, 4)).toEqual([WARNINGS.keyframeInterval]);
    // A window too short to see two keyframes says nothing.
    expect(at(null, 2)).toEqual([]);
  });

  test("fps drop above 10% of the declared rate", () => {
    const fps = (m: number) =>
      healthWarnings({ bitrateKbps: 6000, sourceType: rtmp, probe: { ...good, measuredFps: m } });
    expect(fps(54.1)).toEqual([]);
    expect(fps(53.9)).toEqual([WARNINGS.fpsDrop]);
  });

  test("B-frames are a problem only for WHIP (WebRTC) sources", () => {
    const b = { ...good, hasBFrames: true, audioCodec: "opus" };
    expect(healthWarnings({ bitrateKbps: 6000, sourceType: whip, probe: b })).toEqual([WARNINGS.bFramesWebrtc]);
    expect(healthWarnings({ bitrateKbps: 6000, sourceType: rtmp, probe: { ...good, hasBFrames: true } })).toEqual([]);
  });

  test("codecs: H.264 + AAC, or Opus over WHIP", () => {
    const w = (p: Partial<ProbeResult>, src = rtmp) =>
      healthWarnings({ bitrateKbps: 6000, sourceType: src, probe: { ...good, ...p } });
    expect(w({ videoCodec: "hevc" })).toEqual([WARNINGS.videoCodec]);
    expect(w({ audioCodec: "opus" })).toEqual([WARNINGS.audioCodec]);
    expect(w({ audioCodec: "opus" }, whip)).toEqual([]);
    expect(w({ audioCodec: "mp3" }, whip)).toEqual([WARNINGS.audioCodec]);
    expect(w({ audioCodec: null })).toEqual([WARNINGS.audioMissing]);
  });

  test("audio-only streams skip video checks but flag the missing video", () => {
    const p = { ...good, videoCodec: null, keyframeIntervalMs: null, measuredFps: null, nominalFps: null };
    expect(healthWarnings({ bitrateKbps: 1500, sourceType: rtmp, probe: p })).toEqual([WARNINGS.videoMissing]);
  });

  test("several problems at once are all reported", () => {
    const bad = { ...good, keyframeIntervalMs: 8000, audioCodec: null, measuredFps: 30 };
    expect(healthWarnings({ bitrateKbps: 12000, sourceType: rtmp, probe: bad }).sort()).toEqual(
      [WARNINGS.bitrateHigh, WARNINGS.audioMissing, WARNINGS.keyframeInterval, WARNINGS.fpsDrop].sort(),
    );
  });
});

describe("derived metrics", () => {
  test("bitrate from byte counters", () => {
    expect(bitrateKbps(0, 0, 625_000, 1000)).toBe(5000);
    expect(bitrateKbps(1000, 5000, 1000, 10_000)).toBe(0);
    expect(bitrateKbps(5000, 0, 100, 1000)).toBeNull(); // counter reset (new publisher)
    expect(bitrateKbps(0, 1000, 100, 1000)).toBeNull(); // no time elapsed
  });

  test("fps deficit", () => {
    expect(fpsDeficit({ nominalFps: 30, measuredFps: 27 })).toBeCloseTo(0.1);
    expect(fpsDeficit({ nominalFps: 30, measuredFps: 31 })).toBe(0);
    expect(fpsDeficit({ nominalFps: null, measuredFps: 20 })).toBe(0);
  });

  test("dropped frames: corrupt frames or the fps deficit, whichever is larger", () => {
    const probe = { nominalFps: 30, measuredFps: 27 };
    expect(droppedFrames({ framesInErrorDelta: 0, probe, intervalSeconds: 5 })).toBe(15);
    expect(droppedFrames({ framesInErrorDelta: 40, probe, intervalSeconds: 5 })).toBe(40);
    expect(droppedFrames({ framesInErrorDelta: null, probe: null, intervalSeconds: 5 })).toBe(0);
    expect(droppedFrames({ framesInErrorDelta: -3, probe: null, intervalSeconds: 5 })).toBe(0);
  });
});
