// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The AAC copy of a WHIP source: when it is needed, and the exact ffmpeg command. */
import { describe, expect, test } from "vite-plus/test";
import { aacCopyArgs } from "../src/ffmpeg/args.ts";
import { MtxPath, needsAacCopy, sourceInfo } from "../src/mediamtx.ts";

const path = (tracks: string[], tracks2?: { codec: string }[]) =>
  MtxPath.parse({ name: "live/alice", ready: true, tracks, ...(tracks2 ? { tracks2 } : {}) });

describe("sourceInfo codecs", () => {
  test("WHIP (Opus + H.264) from tracks2, RTMP (AAC + H.264) from tracks", () => {
    const whip = sourceInfo(path(["Opus", "H264"], [{ codec: "Opus" }, { codec: "H264" }]));
    expect(whip).toMatchObject({ hasAudio: true, hasVideo: true, audioCodec: "Opus", videoCodec: "H264" });
    const rtmp = sourceInfo(path(["H264", "MPEG-4 Audio"]));
    expect(rtmp).toMatchObject({ audioCodec: "MPEG-4 Audio", videoCodec: "H264" });
    expect(sourceInfo(path([]))).toMatchObject({ audioCodec: null, videoCodec: null, hasAudio: false });
  });
});

describe("needsAacCopy", () => {
  test("Opus with H.264 video, or Opus alone: yes", () => {
    expect(needsAacCopy(sourceInfo(path(["Opus", "H264"])))).toBe(true);
    expect(needsAacCopy(sourceInfo(path(["Opus"])))).toBe(true);
  });

  test("AAC already, no audio, or video that cannot be copied into HLS: no", () => {
    expect(needsAacCopy(sourceInfo(path(["H264", "MPEG-4 Audio"])))).toBe(false);
    expect(needsAacCopy(sourceInfo(path(["H264"])))).toBe(false);
    expect(needsAacCopy(sourceInfo(path(["VP8", "Opus"])))).toBe(false);
  });
});

describe("aacCopyArgs", () => {
  test("copies video, re-encodes the first audio track to AAC, publishes over RTSP/TCP", () => {
    const args = aacCopyArgs("rtsp://in/live/alice", "rtsp://out/live/alice/aac");
    const joined = args.join(" ");
    expect(joined).toContain("-i rtsp://in/live/alice");
    expect(joined).toContain("-map 0:v:0? -map 0:a:0 -c:v copy -c:a aac -b:a 128k -ac 2 -ar 48000");
    expect(joined).toContain("-rtsp_transport tcp -timeout 10000000");
    expect(args.slice(-1)).toEqual(["rtsp://out/live/alice/aac"]);
    expect(args).toContain("-progress");
  });
});
