// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The AAC copy of a WHIP source: when it is needed, and the exact ffmpeg command. */
import { describe, expect, test } from "vite-plus/test";
import { KEYS } from "@commonair/contracts/internal";
import { createLogger } from "@commonair/observability";
import type { BroadcastInfo, MediaContext } from "../src/context.ts";
import { aacCopyArgs, probeMicros } from "../src/ffmpeg/args.ts";
import { MtxPath, needsAacCopy, sourceInfo } from "../src/mediamtx.ts";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioCompat, SOURCE_AAC_PENDING_MAX_MS } from "../src/transcode/audio-compat.ts";

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
  test("probes the source for one segment (about its GOP) plus a margin, within 1.5–5 s", () => {
    expect(probeMicros(2_000)).toBe(2_500_000);
    expect(probeMicros(500)).toBe(1_500_000);
    expect(probeMicros(8_000)).toBe(5_000_000);
    expect(probeMicros(Number.NaN)).toBe(5_000_000);
    const args = aacCopyArgs("srt://in", "rtsp://out", 1_000_000, 2_000);
    // An input option: before -i.
    expect(args.indexOf("-analyzeduration")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-analyzeduration") + 1]).toBe("2500000");
    expect(aacCopyArgs("srt://in", "rtsp://out", 1_000_000)).not.toContain("-analyzeduration");
  });

  test("copies video, re-encodes the first audio track to AAC, publishes over RTSP/TCP", () => {
    const args = aacCopyArgs("srt://in?streamid=read:live/alice", "rtsp://out/live/alice/aac", 1_000_000);
    const joined = args.join(" ");
    expect(joined).toContain("-copyts -i srt://in?streamid=read:live/alice");
    expect(joined).toContain("-map 0:v:0? -map 0:a:0 -c:v copy -c:a aac -b:a 128k -ac 2 -ar 48000");
    expect(joined).toContain("-start_time_realtime 1000000000 -f rtsp -rtsp_transport tcp");
    expect(args.slice(-1)).toEqual(["rtsp://out/live/alice/aac"]);
    expect(args).toContain("-progress");
  });
});

describe("AudioCompat states", () => {
  // A fake Valkey and MediaMTX; ffmpeg is `false`, so the copy never goes live.
  function setup(tracks: string[]) {
    const keys = new Map<string, string>();
    const valkey = {
      set: async (k: string, v: string) => void keys.set(k, v),
      expire: async () => 1,
      del: async (k: string) => void keys.delete(k),
    };
    const ctx = {
      valkey,
      mtx: { getPath: async () => MtxPath.parse({ name: "live/alice", ready: true, tracks }) },
      timings: { transcodePollMs: 60_000 },
      logger: createLogger({ service: "test", level: "fatal" }),
      rtspBase: "rtsp://127.0.0.1:8554",
      rtspPublishBase: "rtsp://127.0.0.1:18554",
      srtBase: "srt://127.0.0.1:8890",
      clock: {
        w0: async () => 1_000_000,
        sourceSegmentMs: () => null,
      },
      internalSecret: "s",
      ffmpeg: "false",
    } as unknown as MediaContext;
    const b = { broadcastId: "b", channelId: "c", slug: "alice", path: "live/alice" } as BroadcastInfo;
    return { keys, compat: new AudioCompat(ctx, b) };
  }

  test("an Opus source is held back as pending, then served as is if the copy never goes live", async () => {
    const { keys, compat } = setup(["Opus", "H264"]);
    const t0 = 1_000_000;
    await compat.tick(t0);
    expect(keys.get(KEYS.sourceAac("c"))).toBe("pending");
    await compat.tick(t0 + SOURCE_AAC_PENDING_MAX_MS - 1);
    expect(keys.get(KEYS.sourceAac("c"))).toBe("pending");
    await compat.tick(t0 + SOURCE_AAC_PENDING_MAX_MS + 1);
    expect(keys.has(KEYS.sourceAac("c"))).toBe(false);
    await compat.stop();
  });

  test("an AAC source is left alone", async () => {
    const { keys, compat } = setup(["H264", "MPEG-4 Audio"]);
    await compat.tick(1);
    expect(keys.size).toBe(0);
    expect(compat.active).toBe(false);
    await compat.stop();
  });
});

describe("AudioCompat probe", () => {
  // ffmpeg stands in as a script that records its arguments, reports a frame and runs until SIGINT.
  const dir = mkdtempSync(join(tmpdir(), "aac-probe-"));
  const fake = join(dir, "ffmpeg");
  writeFileSync(
    fake,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ntrap 'exit 0' INT\nprintf 'frame=1\\nprogress=continue\\n'\nwhile true; do sleep 0.05; done\n`,
  );
  chmodSync(fake, 0o755);

  test("the copy probes its input for one source segment plus a margin (from the clock), then goes live", async () => {
    const keys = new Map<string, string>();
    const ctx = {
      valkey: {
        set: async (k: string, v: string) => void keys.set(k, v),
        expire: async () => 1,
        del: async (k: string) => void keys.delete(k),
      },
      mtx: { getPath: async () => MtxPath.parse({ name: "live/alice", ready: true, tracks: ["Opus", "H264"] }) },
      timings: { transcodePollMs: 60_000 },
      logger: createLogger({ service: "test", level: "fatal" }),
      rtspBase: "rtsp://127.0.0.1:8554",
      rtspPublishBase: "rtsp://127.0.0.1:18554",
      srtBase: "srt://127.0.0.1:8890",
      clock: { w0: async () => 1_000_000, sourceSegmentMs: () => 2_000 },
      internalSecret: "s",
      ffmpeg: fake,
    } as unknown as MediaContext;
    const b = { broadcastId: "b", channelId: "c", slug: "alice", path: "live/alice" } as BroadcastInfo;
    const compat = new AudioCompat(ctx, b);
    await compat.tick(Date.now());
    const deadline = Date.now() + 5_000;
    while (keys.get(KEYS.sourceAac("c")) !== "1" && Date.now() < deadline) await Bun.sleep(10);
    expect(keys.get(KEYS.sourceAac("c"))).toBe("1");
    const args = (await Bun.file(join(dir, "args")).text()).trim().split("\n");
    expect(args[args.indexOf("-analyzeduration") + 1]).toBe("2500000");
    await compat.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});
