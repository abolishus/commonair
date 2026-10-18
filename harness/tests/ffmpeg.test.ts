// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  BAD_KEYFRAME_SECONDS,
  HIGH_BITRATE_FACTOR,
  ProgressParser,
  type StreamerArgsOptions,
  buildStreamerArgs,
  effectiveEncoding,
  parseListing,
  parseVersion,
  probeFfmpeg,
  videoFilter,
} from "../src/ffmpeg.ts";
import { rtmpPublishUrl, whipPublishTarget } from "../src/streamer.ts";

const base: StreamerArgsOptions = {
  protocol: "rtmp",
  url: "rtmp://localhost:1935/live/chan?key=live_abc",
  width: 1280,
  height: 720,
  fps: 30,
  bitrateKbps: 2500,
  keyframeIntervalSeconds: 2,
  mode: "good",
  startEpochMs: 1_760_000_000_000,
  timecode: false,
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("listing parsers", () => {
  test("parseVersion", () => {
    expect(parseVersion("ffmpeg version 9.0.1 Copyright (c) 2000-2026")).toEqual({ version: "9.0.1", major: 9 });
    expect(parseVersion("ffmpeg version n8.0-12-gabc Copyright")).toEqual({ version: "n8.0-12-gabc", major: 8 });
    expect(parseVersion("garbage")).toEqual({ version: "unknown", major: 0 });
  });

  test("muxers", () => {
    const text = [
      "Formats:",
      " D. = Demuxing supported",
      " .E = Muxing supported",
      " ---",
      "  E flv             FLV (Flash Video)",
      "  E whip            WHIP(WebRTC-HTTP ingestion protocol) muxer",
      "  E mp4             MP4 (MPEG-4 Part 14)",
    ].join("\n");
    const set = parseListing(text, "muxers");
    expect(set.has("whip")).toBe(true);
    expect(set.has("flv")).toBe(true);
    expect(set.has("Demuxing")).toBe(false);
  });

  test("filters (no separator line)", () => {
    const text = [
      "Filters:",
      "  T.. = Timeline support",
      "  ... = no flags",
      " TS geq               V->V       Apply generic equation to each pixel.",
      " .. testsrc2          |->V       Generate another test pattern.",
      " T. drawtext          V->V       Draw text on top of video frames using libfreetype library.",
    ].join("\n");
    const set = parseListing(text, "filters");
    expect([...set].sort()).toEqual(["drawtext", "geq", "testsrc2"]);
  });

  test("encoders", () => {
    const text = [
      "Encoders:",
      " V..... = Video",
      " ------",
      " V....D libx264  libx264 H.264",
      " A....D aac      AAC",
    ].join("\n");
    expect([...parseListing(text, "encoders")].sort()).toEqual(["aac", "libx264"]);
  });

  test("the installed ffmpeg has what streamers need", async () => {
    const caps = await probeFfmpeg();
    expect(caps.major).toBeGreaterThanOrEqual(6);
    for (const f of ["geq", "testsrc2", "sine", "overlay", "crop"]) expect(caps.filters.has(f)).toBe(true);
    expect(caps.encoders.has("libx264")).toBe(true);
    expect(caps.muxers.has("flv")).toBe(true);
  });
});

describe("streamer argument builder", () => {
  test("RTMP: H.264 high + AAC to FLV with the recommended GOP", () => {
    const args = buildStreamerArgs(base);
    expect(args.at(-1)).toBe(base.url);
    expect(flag(args, "-f")).toBe("lavfi");
    expect(args[args.length - 2]).toBe("flv");
    expect(flag(args, "-g")).toBe("60");
    expect(flag(args, "-keyint_min")).toBe("60");
    expect(flag(args, "-b:v")).toBe("2500k");
    expect(flag(args, "-c:a")).toBe("aac");
    expect(flag(args, "-profile:v")).toBe("high");
    expect(args).toContain("-re");
    expect(flag(args, "-progress")).toBe("pipe:1");
    expect(args).not.toContain("-t");
  });

  test("WHIP: baseline, no B-frames, Opus, bearer token", () => {
    const args = buildStreamerArgs({
      ...base,
      protocol: "whip",
      url: "http://localhost:8889/live/chan/whip",
      bearer: "s3cret",
    });
    expect(flag(args, "-authorization")).toBe("s3cret");
    expect(flag(args, "-bf")).toBe("0");
    expect(flag(args, "-c:a")).toBe("libopus");
    expect(flag(args, "-profile:v")).toBe("baseline");
    expect(args[args.length - 4]).toBe("whip");
  });

  test("bad encoder modes", () => {
    expect(effectiveEncoding({ ...base, mode: "wrong-keyframe" })).toEqual({
      bitrateKbps: 2500,
      keyframeIntervalSeconds: BAD_KEYFRAME_SECONDS,
    });
    expect(effectiveEncoding({ ...base, mode: "high-bitrate" }).bitrateKbps).toBe(2500 * HIGH_BITRATE_FACTOR);
    expect(flag(buildStreamerArgs({ ...base, mode: "wrong-keyframe" }), "-g")).toBe(String(30 * BAD_KEYFRAME_SECONDS));
    expect(flag(buildStreamerArgs({ ...base, mode: "high-bitrate" }), "-b:v")).toBe(`${2500 * HIGH_BITRATE_FACTOR}k`);
  });

  test("duration and tone", () => {
    const args = buildStreamerArgs({ ...base, durationSeconds: 12, toneHz: 523 });
    expect(flag(args, "-t")).toBe("12");
    expect(args.some((a) => a.includes("sine=frequency=523"))).toBe(true);
  });

  test("filter graph burns the strip and optionally a timecode", () => {
    const plain = videoFilter({ width: 640, height: 360, startEpochMs: 5, timecode: false });
    expect(plain).toContain("geq=lum='");
    expect(plain).toContain("crop=640:26:0:0");
    expect(plain).not.toContain("drawtext");
    const withClock = videoFilter({ width: 640, height: 360, startEpochMs: 1_760_000_000_000, timecode: true });
    expect(withClock).toContain("drawtext");
    expect(withClock).toContain("gmtime\\:1760000000");
  });

  test("invalid options are refused", () => {
    expect(() => buildStreamerArgs({ ...base, width: 100 })).toThrow(/width/);
    expect(() => buildStreamerArgs({ ...base, width: 641 })).toThrow(/even/);
    expect(() => buildStreamerArgs({ ...base, fps: 0 })).toThrow(/fps/);
    expect(() => buildStreamerArgs({ ...base, protocol: "whip" })).toThrow(/bearer/);
  });

  test("ingest URLs from the API's OBS-style stream key", () => {
    expect(rtmpPublishUrl("rtmp://h:1935/", "chan?key=live_x")).toBe("rtmp://h:1935/live/chan?key=live_x");
    expect(whipPublishTarget("http://h:8889", "chan?key=live_x")).toEqual({
      url: "http://h:8889/live/chan/whip",
      bearer: "live_x",
    });
    expect(() => whipPublishTarget("http://h:8889", "chan")).toThrow(/stream key/);
  });
});

describe("progress parser", () => {
  test("emits one snapshot per block", () => {
    const p = new ProgressParser();
    const lines = [
      "frame=90",
      "fps=30.01",
      "bitrate=2481.3kbits/s",
      "out_time_us=3000000",
      "drop_frames=2",
      "speed=1.0x",
    ];
    for (const l of lines) expect(p.push(l)).toBeNull();
    const snap = p.push("progress=continue");
    expect(snap).toEqual({
      frame: 90,
      fps: 30.01,
      bitrateKbps: 2481.3,
      outTimeMs: 3000,
      dropFrames: 2,
      speed: 1,
      done: false,
    });
    expect(p.push("frame=91")).toBeNull();
    expect(p.push("bitrate=N/A")).toBeNull();
    const end = p.push("progress=end");
    expect(end?.done).toBe(true);
    expect(end?.bitrateKbps).toBeNull();
    expect(p.push("not a key value line")).toBeNull();
  });
});
