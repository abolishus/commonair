// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The mock-target frame probe: URL, arguments and ffprobe output parsing. */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { ffprobeFrameArgs, mockRtmpPort, mockRtmpReadUrl, parseFrameProbe, probeFrames } from "../../src/e6/ffprobe.ts";

describe("mock target URL", () => {
  test("rtmp://localhost:<port>/live/<key>", () => {
    expect(mockRtmpReadUrl("harness-abc123")).toBe("rtmp://localhost:1936/live/harness-abc123");
    expect(mockRtmpReadUrl("k", 19360, "127.0.0.1")).toBe("rtmp://127.0.0.1:19360/live/k");
  });

  test("keys that are not URL-safe are refused", () => {
    expect(() => mockRtmpReadUrl("a/b")).toThrow(/URL-safe/);
    expect(() => mockRtmpReadUrl("a?x=1")).toThrow(/URL-safe/);
    expect(() => mockRtmpReadUrl("")).toThrow(/URL-safe/);
  });

  test("MOCK_RTMP_PORT, default 1936", () => {
    expect(mockRtmpPort({})).toBe(1936);
    expect(mockRtmpPort({ MOCK_RTMP_PORT: " 2000 " })).toBe(2000);
    expect(() => mockRtmpPort({ MOCK_RTMP_PORT: "x" })).toThrow(/TCP port/);
    expect(() => mockRtmpPort({ MOCK_RTMP_PORT: "70000" })).toThrow(/TCP port/);
  });
});

describe("ffprobe arguments and parsing", () => {
  test("count the first video stream's frames for N seconds, JSON out, URL last", () => {
    const args = ffprobeFrameArgs("rtmp://h/live/k", 10);
    expect(args.at(-1)).toBe("rtmp://h/live/k");
    expect(args).toContain("-count_frames");
    expect(args.join(" ")).toContain("-read_intervals %+10");
    expect(args.join(" ")).toContain("-select_streams v:0");
    expect(args.join(" ")).toContain("-show_entries stream=nb_read_frames,width,height");
    expect(args.join(" ")).toContain("-rw_timeout 8000000");
    expect(() => ffprobeFrameArgs("u", 0)).toThrow(RangeError);
  });

  test("parse frames and size", () => {
    const out = JSON.stringify({ programs: [], streams: [{ width: 1280, height: 720, nb_read_frames: "301" }] });
    expect(parseFrameProbe(out, 0)).toEqual({ frames: 301, width: 1280, height: 720, exitCode: 0 });
  });

  test("no stream, garbage or bad numbers mean 0 frames", () => {
    expect(parseFrameProbe("{}", 1).frames).toBe(0);
    expect(parseFrameProbe("", 1)).toEqual({ frames: 0, width: null, height: null, exitCode: 1 });
    expect(parseFrameProbe(JSON.stringify({ streams: [{ nb_read_frames: "N/A" }] }), 0).frames).toBe(0);
    expect(parseFrameProbe(JSON.stringify({ streams: [{ width: -1, height: 1.5 }] }), 0)).toMatchObject({
      width: null,
      height: null,
    });
  });
});

describe("probeFrames", () => {
  test("a missing binary reports 0 frames instead of throwing", async () => {
    const r = await probeFrames("rtmp://localhost:1/live/k", 1, "/nonexistent/ffprobe-e6");
    expect(r.frames).toBe(0);
  });

  test("reads a fake ffprobe's JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e6-ffprobe-"));
    const bin = join(dir, "ffprobe");
    writeFileSync(bin, `#!/bin/sh\necho '{"streams":[{"width":640,"height":360,"nb_read_frames":"75"}]}'\n`);
    chmodSync(bin, 0o755);
    expect(await probeFrames("rtmp://h/live/k", 1, bin)).toEqual({ frames: 75, width: 640, height: 360, exitCode: 0 });
  });
});
