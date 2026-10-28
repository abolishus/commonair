// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  aacCopyArgs,
  ALIGN_START,
  assertSrtSecret,
  clipArgs,
  internalRtspUrl,
  internalSrtUrl,
  KEYFRAME_EXPR,
  ladderArgs,
  SRT_LATENCY_US,
  probeArgs,
  recorderArgs,
  simulcastArgs,
  simulcastOutput,
  thumbnailArgs,
} from "../src/ffmpeg/args.ts";
import { REDACTED, redact, redactArgs } from "../src/ffmpeg/redact.ts";
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
  const target = parseTargetUrl("rtmp://ingest.example.net/live/");
  const args = simulcastArgs(input, simulcastOutput(target, KEY, "203.0.114.7"));

  test("copies streams to FLV over RTSP/TCP with machine-readable progress", () => {
    expect(values(args, "-c")).toEqual(["copy"]);
    expect(values(args, "-f")).toEqual(["flv"]);
    expect(values(args, "-rtsp_transport")).toEqual(["tcp"]);
    expect(values(args, "-progress")).toEqual(["pipe:1"]);
    expect(args).toContain("-nostdin");
  });

  test("rtmp is pinned to the vetted address; the server still sees its host name as tcUrl", () => {
    expect(args.at(-1)).toBe(`rtmp://203.0.114.7:1935/live/${KEY}`);
    expect(values(args, "-rtmp_tcurl")).toEqual(["rtmp://ingest.example.net/live"]);
  });

  test("rtmps keeps the host name (SNI); query strings follow the key; IPv6 is bracketed", () => {
    const tls = simulcastOutput(parseTargetUrl("rtmps://live.example.com:443/app?x=1"), KEY, "203.0.114.7");
    expect(tls).toEqual({ url: `rtmps://live.example.com:443/app/${KEY}?x=1`, tcUrl: null });
    expect(simulcastArgs(input, tls)).not.toContain("-rtmp_tcurl");
    expect(simulcastOutput(parseTargetUrl("rtmps://live.example.com/app"), KEY, "x").url).toBe(
      `rtmps://live.example.com/app/${KEY}`,
    );
    expect(simulcastOutput(parseTargetUrl("rtmp://h.example/app"), KEY, "2001:4860::1").url).toBe(
      `rtmp://[2001:4860::1]:1935/app/${KEY}`,
    );
  });

  test("redaction removes the stream key, the whole target URL and the internal password", () => {
    const out = simulcastOutput(parseTargetUrl("rtmp://ingest.example.net/live?token=abc"), KEY, "203.0.114.7");
    const logged = redactArgs(simulcastArgs(input, out), [KEY, SECRET, out.url, "?token=abc"]).join(" ");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("token=abc");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(encodeURIComponent(SECRET));
    expect(logged).toContain(`rtsp://internal:${REDACTED}@mediamtx:8554/live/alice`);
    expect(logged).not.toContain("203.0.114.7:1935/live");
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

describe("SRT input (ADR 0012 A2)", () => {
  const url = internalSrtUrl("srt://mediamtx:8890", "live/alice", SECRET);

  test("reads the path as the internal user, the secret percent-encoded, separators literal", () => {
    expect(url.startsWith("srt://mediamtx:8890?")).toBe(true);
    const streamid = url.slice(url.indexOf("streamid=") + "streamid=".length);
    expect(streamid.split(":")).toEqual(["read", "live%2Falice", "internal", encodeURIComponent(SECRET)]);
    // What ffmpeg sends after percent-decoding the value (proven against MediaMTX in
    // clock-mediamtx.int.test.ts): the raw secret, `+` included.
    expect(decodeURIComponent(streamid)).toBe(`read:live/alice:internal:${SECRET}`);
    expect(url.endsWith(`streamid=read:live%2Falice:internal:${encodeURIComponent(SECRET)}`)).toBe(true);
  });

  test("bounded waits and an explicit internal latency", () => {
    const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(q.get("mode")).toBe("caller");
    expect(q.get("latency")).toBe(String(SRT_LATENCY_US));
    expect(Number(q.get("connect_timeout"))).toBeGreaterThan(0);
    expect(Number(q.get("timeout"))).toBeGreaterThan(0);
  });

  test("a secret MediaMTX would split, or a non-SRT base, is refused", () => {
    expect(() => internalSrtUrl("srt://m:8890", "live/a", "a:b")).toThrow(/must not contain ':'/);
    expect(() => assertSrtSecret("a:b")).toThrow(/MEDIA_INTERNAL_PASSWORD must not contain ':'/);
    expect(() => assertSrtSecret("0f9e8d7c6b5a")).not.toThrow();
    expect(() => internalSrtUrl("rtsp://m:8554", "live/a", "s")).toThrow(/srt:\/\//);
  });

  test("redaction masks the streamid secret with no secrets listed, plain and encoded", () => {
    const masked = redact(url, []);
    expect(masked).toBe(url.replace(encodeURIComponent(SECRET), REDACTED));
    const raw = `srt://m:8890?streamid=read:live/alice:internal:${SECRET}`;
    expect(redact(raw, [])).toBe(`srt://m:8890?streamid=read:live/alice:internal:${REDACTED}`);
    const encoded = `srt://m:8890?streamid=${encodeURIComponent(`read:live/alice:internal:${SECRET}`)}`;
    expect(redact(encoded, [])).toBe(`srt://m:8890?streamid=read%3Alive%2Falice%3Ainternal%3A${REDACTED}`);
    for (const out of redactArgs(
      ladderArgs({ input: url, w0Ms: W0, outputFor, rungs: RUNGS, encoder: "libx264" }),
      [],
    )) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(encodeURIComponent(SECRET));
    }
  });

  test("an ffmpeg error line echoing the SRT URL is masked; a query-only streamid is kept", () => {
    const line = `[srt @ 0x1] Connection to ${url} failed: Connection setup failure: connection timed out`;
    const out = redact(line, []);
    expect(out).not.toContain(encodeURIComponent(SECRET));
    expect(out.endsWith(`internal:${REDACTED} failed: Connection setup failure: connection timed out`)).toBe(true);
    expect(redact("srt://m?streamid=read:live/a:key=1", [])).toBe("srt://m?streamid=read:live/a:key=1");
  });
});

const W0 = 1_793_148_779_310.25;
const W0_US = String(Math.round(W0 * 1000));
const RUNGS = selectRungs({ height: 1080, hasAudio: true });
const outputFor = (r: string) => `rtsp://internal:x@mediamtx:8554/live/alice/${r}`;

/** Indexes of the RTSP outputs (the argument after `-f rtsp … -pkt_size 1200`). */
const outputs = (args: string[]) => args.flatMap((a, i) => (a.startsWith("rtsp://") ? [i] : []));

describe("ladder args", () => {
  const input = internalSrtUrl("srt://mediamtx:8890", "live/alice", "x");

  test("one aligned split filter, one output per rung, phase-locked keyframes", () => {
    const args = ladderArgs({ input, w0Ms: W0, outputFor, rungs: RUNGS, encoder: "libx264" });
    const filter = values(args, "-filter_complex")[0] ?? "";
    expect(filter.startsWith(`[0:v:0]${ALIGN_START},split=3`)).toBe(true);
    expect(filter).toContain("scale=-2:1080");
    expect(filter).toContain("scale=-2:720");
    expect(filter).toContain("scale=-2:480");
    expect(args.filter((a) => a.startsWith("rtsp://") && a.includes("/live/alice/"))).toEqual([
      outputFor("1080p"),
      outputFor("720p"),
      outputFor("480p"),
      outputFor("audio"),
    ]);
    expect(values(args, "-force_key_frames")).toEqual(Array(3).fill(KEYFRAME_EXPR));
    expect(KEYFRAME_EXPR).toBe("expr:if(isnan(prev_forced_t),1,gte(floor(t/2),floor(prev_forced_t/2)+1))");
    expect(values(args, "-bf")).toEqual(["0", "0", "0"]);
    expect(values(args, "-c:v")).toEqual(["libx264", "libx264", "libx264"]);
    expect(values(args, "-preset")).toEqual(["veryfast", "veryfast", "veryfast"]);
    expect(values(args, "-tune")).toEqual(["zerolatency", "zerolatency", "zerolatency"]);
    expect(values(args, "-b:v")).toEqual(["6000k", "3000k", "1200k"]);
    expect(values(args, "-f")).toEqual(["rtsp", "rtsp", "rtsp", "rtsp"]);
  });

  test("reads SRT with -copyts and anchors every RTSP output, and only those, at W0", () => {
    const args = ladderArgs({ input, w0Ms: W0, outputFor, rungs: RUNGS, encoder: "libx264" });
    expect(values(args, "-i")).toEqual([input]);
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-i"));
    expect(args).not.toContain("-rtsp_transport tcp -timeout");
    expect(values(args, "-start_time_realtime")).toEqual(Array(4).fill(W0_US));
    // Each one belongs to the next output: no other output sits between it and its URL.
    const outs = outputs(args);
    let prev = 0;
    for (const o of outs) {
      const flag = args.indexOf("-start_time_realtime", prev);
      expect(flag).toBeGreaterThan(prev);
      expect(flag).toBeLessThan(o);
      prev = o;
    }
  });

  test("the audio rung is AAC 96k with no video, anchored too", () => {
    const args = ladderArgs({
      input,
      w0Ms: W0,
      outputFor,
      rungs: selectRungs({ height: null, hasAudio: true }),
      encoder: "libx264",
    });
    expect(values(args, "-filter_complex")).toEqual([]);
    expect(args).toContain("-vn");
    expect(values(args, "-c:a")).toEqual(["aac"]);
    expect(values(args, "-b:a")).toEqual(["96k"]);
    expect(values(args, "-start_time_realtime")).toEqual([W0_US]);
  });

  test("NVENC flags when the GPU encoder was selected, same keyframe expression", () => {
    const args = ladderArgs({
      input,
      w0Ms: W0,
      outputFor,
      rungs: selectRungs({ height: 720, hasAudio: false }),
      encoder: "h264_nvenc",
    });
    expect(values(args, "-c:v")).toEqual(["h264_nvenc", "h264_nvenc"]);
    expect(values(args, "-tune")).toEqual(["ll", "ll"]);
    expect(values(args, "-force_key_frames")).toEqual([KEYFRAME_EXPR, KEYFRAME_EXPR]);
    expect(values(args, "-forced-idr")).toEqual(["1", "1"]);
    expect(args).not.toContain("libx264");
  });

  test("a missing or nonsensical W0 is refused, never silently unanchored", () => {
    for (const w0Ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => ladderArgs({ input, w0Ms, outputFor, rungs: RUNGS, encoder: "libx264" })).toThrow(/W0 must be/);
  });
});

describe("AAC copy args", () => {
  test("reads SRT with -copyts and anchors its one output at W0", () => {
    const input = internalSrtUrl("srt://mediamtx:8890", "live/alice", "x");
    const args = aacCopyArgs(input, outputFor("aac"), W0);
    expect(values(args, "-i")).toEqual([input]);
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-i"));
    expect(values(args, "-start_time_realtime")).toEqual([W0_US]);
    expect(args.indexOf("-start_time_realtime")).toBeLessThan(args.indexOf(outputFor("aac")));
    expect(args.at(-1)).toBe(outputFor("aac"));
  });
});

describe("RTSP stays on the readers that carry no PDT", () => {
  const rtsp = internalRtspUrl("rtsp://mediamtx:8554", "live/alice", "x");
  test("thumbnails, simulcast and probes read RTSP over TCP, without -copyts or W0", () => {
    const target = simulcastOutput(parseTargetUrl("rtmp://ingest.example.net/live/"), KEY, "203.0.114.7");
    for (const args of [thumbnailArgs(rtsp, "webp"), simulcastArgs(rtsp, target), probeArgs(rtsp, 4)]) {
      expect(args).toContain(rtsp);
      expect(values(args, "-rtsp_transport")[0]).toBe("tcp");
      expect(args).not.toContain("-copyts");
      expect(args).not.toContain("-start_time_realtime");
    }
  });
});

describe("recorder, thumbnail, clip and probe args", () => {
  const input = internalSrtUrl("srt://mediamtx:8890", "live/a", "x");

  test("recorder copies into fMP4 HLS with per-run file names, reading SRT with -copyts", () => {
    const args = recorderArgs({ input, dir: "/w/b1", runId: "r1", segmentSeconds: 4, aacAudio: false });
    expect(values(args, "-i")).toEqual([input]);
    expect(args.indexOf("-copyts")).toBeLessThan(args.indexOf("-i"));
    expect(values(args, "-c")).toEqual(["copy"]);
    expect(values(args, "-hls_segment_type")).toEqual(["fmp4"]);
    expect(values(args, "-hls_time")).toEqual(["4"]);
    expect(values(args, "-hls_list_size")).toEqual(["0"]);
    expect(values(args, "-hls_fmp4_init_filename")).toEqual(["init_r1.mp4"]);
    expect(values(args, "-hls_segment_filename")).toEqual(["/w/b1/r1_%06d.m4s"]);
    expect(values(args, "-hls_flags")).toEqual(["independent_segments+program_date_time+temp_file"]);
    // fMP4 times stay on the source timeline (R4): the MP4 muxer must not rebase them to 0.
    expect(values(args, "-hls_segment_options")).toEqual(["movflags=+frag_discont"]);
    expect(args).not.toContain("-start_time_realtime");
    expect(args).not.toContain("-bsf:a");
    expect(args[args.length - 1]).toBe("/w/b1/r1.m3u8");
  });

  test("AAC from MPEG-TS is rewrapped for MP4; Opus is left alone", () => {
    const aac = recorderArgs({ input, dir: "/w", runId: "r1", segmentSeconds: 4, aacAudio: true });
    expect(values(aac, "-bsf:a")).toEqual(["aac_adtstoasc"]);
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
