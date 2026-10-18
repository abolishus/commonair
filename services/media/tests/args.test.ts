// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  clipArgs,
  internalRtspUrl,
  ladderArgs,
  probeArgs,
  recorderArgs,
  simulcastArgs,
  thumbnailArgs,
} from "../src/ffmpeg/args.ts";
import { REDACTED, redact, redactArgs } from "../src/ffmpeg/redact.ts";
import { placeholderFor } from "../src/net/rtmp-proxy.ts";
import { parseTargetUrl } from "../src/net/ssrf.ts";
import { selectRungs } from "../src/transcode/ladder.ts";

const SECRET = "s3cr3t/with+chars=and@at";
const KEY = "live_123456789_AbCdEfGhIjKlMnOp";

/** Value following a flag, for every occurrence. */
const values = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe("URLs", () => {
  test("internal RTSP URL carries the internal user and an encoded password", () => {
    const u = internalRtspUrl("rtsp://mediamtx:8554", "live/alice", SECRET);
    expect(u.startsWith("rtsp://internal:")).toBe(true);
    expect(u.endsWith("@mediamtx:8554/live/alice")).toBe(true);
    const parsed = new URL(u);
    expect(decodeURIComponent(parsed.password)).toBe(SECRET);
  });
});

describe("simulcast args", () => {
  const input = internalRtspUrl("rtsp://mediamtx:8554", "live/alice", SECRET);
  const target = parseTargetUrl("rtmps://ingest.example.net/live/extra");
  const placeholder = placeholderFor(KEY);
  const args = simulcastArgs(input, {
    proxyPort: 40123,
    app: target.app,
    tcUrl: target.tcUrl,
    playpath: `${target.playpathPrefix}/${placeholder}`,
  });

  test("copies streams to FLV over RTSP/TCP with machine-readable progress", () => {
    expect(values(args, "-c")).toEqual(["copy"]);
    expect(values(args, "-f")).toEqual(["flv"]);
    expect(values(args, "-rtsp_transport")).toEqual(["tcp"]);
    expect(values(args, "-progress")).toEqual(["pipe:1"]);
    expect(args).toContain("-nostdin");
  });

  test("the stream key is never in argv: ffmpeg publishes a placeholder to the loopback proxy", () => {
    expect(args.join(" ")).not.toContain(KEY);
    expect(args.at(-1)).toBe("rtmp://127.0.0.1:40123/simulcast");
    expect(values(args, "-rtmp_app")).toEqual(["live"]);
    expect(values(args, "-rtmp_tcurl")).toEqual(["rtmps://ingest.example.net/live"]);
    expect(values(args, "-rtmp_playpath")).toEqual([`extra/${placeholder}`]);
    expect(placeholder).toHaveLength(KEY.length);
    expect(placeholder).not.toBe(KEY);
  });

  test("redaction removes the internal password from logged args", () => {
    const logged = redactArgs(args, [KEY, SECRET]).join(" ");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(encodeURIComponent(SECRET));
    expect(logged).toContain(`rtsp://internal:${REDACTED}@mediamtx:8554/live/alice`);
  });

  test("redaction also cleans ffmpeg error lines that echo the URL", () => {
    const line = `[flv @ 0x1] Failed to connect to rtmp://ingest.example.net/live/${KEY}: Connection refused`;
    expect(redact(line, [KEY])).toBe(
      `[flv @ 0x1] Failed to connect to rtmp://ingest.example.net/live/${REDACTED}: Connection refused`,
    );
  });

  test("URL passwords are redacted even when not listed as secrets", () => {
    expect(redact("rtsp://internal:hunter2@host/live/x", [])).toBe(`rtsp://internal:${REDACTED}@host/live/x`);
  });

  test("empty secrets never blank out the text", () => {
    expect(redact("hello", [""])).toBe("hello");
  });
});

describe("ladder args", () => {
  const input = "rtsp://internal:x@mediamtx:8554/live/alice";
  const outputFor = (r: string) => `rtsp://internal:x@mediamtx:8554/live/alice/${r}`;

  test("one split filter, one output per rung, keyframes forced every 2 s", () => {
    const rungs = selectRungs({ height: 1080, hasAudio: true });
    const args = ladderArgs({ input, outputFor, rungs, encoder: "libx264" });
    const filter = values(args, "-filter_complex")[0] ?? "";
    expect(filter).toContain("split=3");
    expect(filter).toContain("scale=-2:1080");
    expect(filter).toContain("scale=-2:720");
    expect(filter).toContain("scale=-2:480");
    expect(args.filter((a) => a.startsWith("rtsp://") && a.includes("/live/alice/"))).toEqual([
      outputFor("1080p"),
      outputFor("720p"),
      outputFor("480p"),
      outputFor("audio"),
    ]);
    expect(values(args, "-force_key_frames")).toEqual(Array(3).fill("expr:gte(t,n_forced*2)"));
    expect(values(args, "-bf")).toEqual(["0", "0", "0"]);
    expect(values(args, "-c:v")).toEqual(["libx264", "libx264", "libx264"]);
    expect(values(args, "-preset")).toEqual(["veryfast", "veryfast", "veryfast"]);
    expect(values(args, "-tune")).toEqual(["zerolatency", "zerolatency", "zerolatency"]);
    expect(values(args, "-b:v")).toEqual(["6000k", "3000k", "1200k"]);
    expect(values(args, "-f")).toEqual(["rtsp", "rtsp", "rtsp", "rtsp"]);
  });

  test("the audio rung is AAC 96k with no video", () => {
    const args = ladderArgs({
      input,
      outputFor,
      rungs: selectRungs({ height: null, hasAudio: true }),
      encoder: "libx264",
    });
    expect(values(args, "-filter_complex")).toEqual([]);
    expect(args).toContain("-vn");
    expect(values(args, "-c:a")).toEqual(["aac"]);
    expect(values(args, "-b:a")).toEqual(["96k"]);
  });

  test("NVENC flags when the GPU encoder was selected", () => {
    const args = ladderArgs({
      input,
      outputFor,
      rungs: selectRungs({ height: 720, hasAudio: false }),
      encoder: "h264_nvenc",
    });
    expect(values(args, "-c:v")).toEqual(["h264_nvenc", "h264_nvenc"]);
    expect(values(args, "-tune")).toEqual(["ll", "ll"]);
    expect(args).not.toContain("libx264");
  });
});

describe("recorder, thumbnail, clip and probe args", () => {
  test("recorder copies into fMP4 HLS with per-run file names", () => {
    const args = recorderArgs({ input: "rtsp://x/live/a", dir: "/w/b1", runId: "r1", segmentSeconds: 4 });
    expect(values(args, "-c")).toEqual(["copy"]);
    expect(values(args, "-hls_segment_type")).toEqual(["fmp4"]);
    expect(values(args, "-hls_time")).toEqual(["4"]);
    expect(values(args, "-hls_list_size")).toEqual(["0"]);
    expect(values(args, "-hls_fmp4_init_filename")).toEqual(["init_r1.mp4"]);
    expect(values(args, "-hls_segment_filename")).toEqual(["/w/b1/r1_%06d.m4s"]);
    expect(values(args, "-hls_flags")[0]).toContain("program_date_time");
    expect(args[args.length - 1]).toBe("/w/b1/r1.m3u8");
  });

  test("thumbnail is one 640×360 frame in the requested format on stdout", () => {
    const webp = thumbnailArgs("rtsp://x/live/a", "webp");
    expect(values(webp, "-frames:v")).toEqual(["1"]);
    expect(values(webp, "-vf")[0]).toContain("scale=640:360");
    expect(values(webp, "-vf")[0]).toContain("pad=640:360");
    expect(values(webp, "-c:v")).toEqual(["libwebp"]);
    expect(webp[webp.length - 1]).toBe("pipe:1");
    expect(values(thumbnailArgs("rtsp://x/live/a", "jpeg"), "-c:v")).toEqual(["mjpeg"]);
  });

  test("clip re-encodes the exact window into a faststart MP4", () => {
    const args = clipArgs({
      input: "/s.mp4",
      startSeconds: 3.25,
      durationSeconds: 30,
      output: "/o.mp4",
      encoder: "libx264",
    });
    expect(values(args, "-ss")).toEqual(["3.250"]);
    expect(values(args, "-t")).toEqual(["30.000"]);
    expect(values(args, "-movflags")).toEqual(["+faststart"]);
    expect(args[args.length - 1]).toBe("/o.mp4");
  });

  test("probe reads a bounded window as JSON with packet flags", () => {
    const args = probeArgs("rtsp://x/live/a", 4);
    expect(values(args, "-read_intervals")).toEqual(["%+4"]);
    expect(values(args, "-of")).toEqual(["json"]);
    expect(values(args, "-show_entries")[0]).toContain("flags");
    expect(args).toContain("-show_packets");
  });
});
