// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pins the MediaMTX behaviour the media clock (ADR 0012, variant A2) relies on, against the
 * production config (infra/mediamtx/mediamtx.yml) on the compose image:
 *
 * - every `-copyts` SRT reader session sees one stream timeline (same `strip − pts`);
 * - LL-HLS `tfdt` is that timeline plus 10 s, so W0 from one segment anchors SRT readers;
 * - a ladder built by `ladderArgs` with that W0 publishes rungs whose PDT is the source's, with
 *   keyframes on the timeline's 2 s boundaries whatever phase it starts at;
 * - the recorder over SRT writes fMP4 on the same timeline, so `W0 + time` is the source's PDT.
 *
 * Frames are identified by the timestamp strip the harness streamer burns into every frame. SRT
 * readers (the ladder and recorder too) run in a container sharing MediaMTX's network namespace,
 * so the host ffmpeg needs no SRT support.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { buildStreamerArgs } from "../../../harness/src/ffmpeg.ts";
import { decodeStrip, graySource } from "../../../harness/src/timestamp-strip.ts";
import { parseFragment, parseInit } from "../src/clock/boxes.ts";
import { fetchW0, firstVariant, newestSegment, pdtTrack } from "../src/clock/w0.ts";
import { internalRtspUrl, internalSrtUrl, ladderArgs, recorderArgs, recorderPlaylist } from "../src/ffmpeg/args.ts";
import { AUDIO_RUNG, type Rung } from "../src/transcode/ladder.ts";
import { parsePlaylist } from "../src/vod/playlist.ts";
import { MEDIAMTX_IMAGE, podmanAvailable, startMediaMtx, type Container } from "./helpers/containers.ts";

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

if (!podmanAvailable()) throw new Error("media integration tests need podman (rootless is fine)");

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const run = crypto.randomUUID().slice(0, 8);
/** Reserved characters on purpose: the SRT `streamid` must deliver them to the auth hook intact. */
const SECRET = `s3cr3t/with+chars=and@at-${run}`;
const FRAME_MS = 1000 / 30;
const FPS = 30;

function podman(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim() };
}

/**
 * The production media image's ffmpeg when it is built locally, else the compose MediaMTX image's
 * (8.x); CLOCK_FFMPEG_IMAGE overrides. Both have libsrt.
 */
const FFMPEG_IMAGE =
  process.env.CLOCK_FFMPEG_IMAGE ??
  (podman(["image", "exists", "localhost/commonair/media:dev"]).code === 0
    ? "localhost/commonair/media:dev"
    : MEDIAMTX_IMAGE);

interface AuthCall {
  user: string;
  password: string;
  action: string;
  path: string;
  protocol: string;
}
const auth: AuthCall[] = [];
/** Fake API: allows every MediaMTX action, records auth requests. */
const fakeApi = Bun.serve({
  port: 0,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => null)) as AuthCall | null;
    if (url.pathname.endsWith("/auth") && body) auth.push(body);
    return new Response(null, { status: 204 });
  },
});

let mtx: Container;
const sources: Bun.Subprocess[] = [];
const containers = new Set<string>();
const scratch = mkdtempSync(join(REPO_ROOT, ".cache", "media-int-clock-"));
// The ffmpeg image may run as another user than the host's.
chmodSync(scratch, 0o777);

const hlsBase = () => `http://127.0.0.1:${mtx.port("8888/tcp")}`;
const basic = `Basic ${Buffer.from(`internal:${SECRET}`).toString("base64")}`;
/** Inside MediaMTX's network namespace. */
const SRT_BASE = "srt://127.0.0.1:8890";
const RTSP_BASE = "rtsp://127.0.0.1:8554";

const PLAIN = `clk_${run}`;
const BFRAMES = `clkb_${run}`;

function startSource(slug: string, bframes: boolean): void {
  const args = buildStreamerArgs({
    protocol: "rtmp",
    url: `rtmp://127.0.0.1:${mtx.port("1935/tcp")}/live/${slug}?key=k`,
    width: 640,
    height: 360,
    fps: FPS,
    bitrateKbps: 800,
    keyframeIntervalSeconds: 2,
    mode: "good",
    startEpochMs: Date.now(),
    timecode: false,
  });
  if (bframes) {
    // zerolatency forbids B-frames; drop it and ask for two.
    const tune = args.indexOf("zerolatency");
    args.splice(tune - 1, 2);
    args.splice(args.indexOf("-profile:v"), 0, "-bf", "2");
  }
  sources.push(Bun.spawn(["ffmpeg", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
}

/** ffmpeg in a container on MediaMTX's network, with `dirs` mounted at the same paths. */
function containerFfmpeg(args: string[], dirs: string[] = []): { name: string; cmd: string[] } {
  const name = `media-int-clockff-${crypto.randomUUID().slice(0, 8)}`;
  containers.add(name);
  return {
    name,
    cmd: [
      "podman",
      "run",
      "--rm",
      "-i",
      "--name",
      name,
      "--network",
      `container:${mtx.name}`,
      ...dirs.flatMap((d) => ["-v", `${d}:${d}`]),
      "--entrypoint",
      "ffmpeg",
      FFMPEG_IMAGE,
      ...args,
    ],
  };
}

function removeContainer(name: string): void {
  podman(["rm", "-f", "-t", "1", name]);
  containers.delete(name);
}

interface Frame {
  /** Presentation time in seconds as ffmpeg reports it (`-copyts`). */
  pts: number;
  strip: number | null;
}

const W = 320;
const H = 180;
const DECODE = ["-fps_mode", "passthrough", "-vf", `showinfo,scale=${W}:${H},format=gray`, "-f", "rawvideo", "pipe:1"];

async function decodeFrames(cmd: string[], input?: Uint8Array): Promise<Frame[]> {
  const p = Bun.spawn(cmd, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
  if (input && p.stdin) {
    void p.stdin.write(input);
    await p.stdin.end();
  }
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  await p.exited;
  const pts = [...err.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const bytes = new Uint8Array(out);
  const frames: Frame[] = [];
  for (let i = 0; i < Math.min(Math.floor(bytes.length / (W * H)), pts.length); i++)
    frames.push({
      pts: pts[i] ?? Number.NaN,
      strip: decodeStrip(graySource(bytes.subarray(i * W * H, (i + 1) * W * H), W, H)),
    });
  if (frames.length === 0) throw new Error(`no frames decoded: ${err.slice(-1500)}`);
  return frames;
}

/** `strip − pts` (ms) of one SRT reader session: the session's timeline origin in wall-clock terms. */
async function srtOrigin(slug: string): Promise<number> {
  const { name, cmd } = containerFfmpeg([
    "-hide_banner",
    "-loglevel",
    "info",
    "-copyts",
    "-i",
    internalSrtUrl(SRT_BASE, `live/${slug}`, SECRET),
    "-frames:v",
    "12",
    ...DECODE,
  ]);
  try {
    const ks = (await decodeFrames(cmd)).flatMap((f) => (f.strip === null ? [] : [f.strip - f.pts * 1000]));
    expect(ks.length).toBeGreaterThan(3);
    // Every frame of a session gives the same origin (to rounding).
    expect(Math.max(...ks) - Math.min(...ks)).toBeLessThan(2);
    return ks[0] ?? Number.NaN;
  } finally {
    removeContainer(name);
  }
}

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { authorization: basic } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

interface HlsSample {
  pdtMs: number;
  /** First sample presentation time on the HLS timeline (tfdt + cto), seconds. */
  pts: number;
  /** Strip of the first presented frame. */
  strip: number;
  uri: string;
}

/** The newest complete LL-HLS segment of a path: PDT, first presentation time and strip. */
async function hlsSample(path: string): Promise<HlsSample> {
  const mvUrl = `${hlsBase()}/${path}/index.m3u8`;
  const mv = new TextDecoder().decode(await get(mvUrl));
  const variant = firstVariant(mv);
  const mediaUrl = variant ? new URL(variant, mvUrl).toString() : mvUrl;
  const media = variant ? new TextDecoder().decode(await get(mediaUrl)) : mv;
  const seg = newestSegment(media);
  if (!seg) throw new Error(`no complete segment on ${path} yet`);
  const init = await get(new URL(seg.map, mediaUrl).toString());
  const bytes = await get(new URL(seg.uri, mediaUrl).toString());
  const track = pdtTrack(parseInit(init));
  const frag = parseFragment(bytes).find((f) => f.trackId === track?.trackId);
  if (!track || !frag) throw new Error("no video fragment");
  const frames = await decodeFrames(
    ["ffmpeg", "-hide_banner", "-loglevel", "info", "-i", "pipe:0", "-frames:v", "1", ...DECODE],
    Buffer.concat([init, bytes]),
  );
  const strip = frames[0]?.strip;
  if (strip === null || strip === undefined) throw new Error("no strip in the segment's first frame");
  return {
    pdtMs: seg.pdtMs,
    pts: (frag.baseDecodeTime + frag.firstCompositionOffset) / track.timescale,
    strip,
    uri: seg.uri,
  };
}

/** Distinct newest segments of a path, polled for `ms`. */
async function hlsSamples(path: string, ms: number): Promise<HlsSample[]> {
  const seen = new Map<string, HlsSample>();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = await hlsSample(path).catch(() => null);
    if (s && !seen.has(s.uri.split("?")[0] ?? s.uri)) seen.set(s.uri.split("?")[0] ?? s.uri, s);
    await Bun.sleep(700);
  }
  return [...seen.values()];
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
}

const sourceE = new Map<string, number>();
const origin = new Map<string, number>();

beforeAll(async () => {
  mtx = startMediaMtx({ apiBase: `http://host.containers.internal:${fakeApi.port}`, internalSecret: "unused" });
  startSource(PLAIN, false);
  startSource(BFRAMES, true);
  for (const slug of [PLAIN, BFRAMES]) await waitFor(`${slug} on LL-HLS`, () => hlsSample(`live/${slug}`), 60_000);
}, 120_000);

afterAll(async () => {
  for (const s of sources) s.kill("SIGKILL");
  for (const name of Array.from(containers)) removeContainer(name);
  await fakeApi.stop(true);
  if (process.env.TEST_MTX_LOGS) console.warn(mtx?.logs());
  mtx?.stop();
  rmSync(scratch, { recursive: true, force: true });
});

test("the integration MediaMTX image is the one compose runs", () => {
  const compose = readFileSync(join(REPO_ROOT, "compose.yaml"), "utf8");
  const images = [...compose.matchAll(/image:\s*(\S*bluenviron\/mediamtx\S*)/g)].map((m) => m[1]);
  expect(images.length).toBeGreaterThan(0);
  for (const image of images) expect(image).toBe(MEDIAMTX_IMAGE);
});

describe.each([
  ["no B-frames", PLAIN],
  ["B-frames", BFRAMES],
])("RTMP source with %s", (_label, slug) => {
  test("every -copyts SRT reader session sees one timeline", async () => {
    const origins: number[] = [];
    for (let i = 0; i < 3; i++) {
      origins.push(await srtOrigin(slug));
      await Bun.sleep(1_500);
    }
    expect(Math.max(...origins) - Math.min(...origins)).toBeLessThanOrEqual(FRAME_MS);
    origin.set(slug, origins[0] ?? Number.NaN);
    // The secret reached the auth hook intact through the percent-encoded streamid.
    const reads = auth.filter((a) => a.protocol === "srt" && a.path === `live/${slug}`);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.action).toBe("read");
      expect(r.user).toBe("internal");
      expect(r.password).toBe(SECRET);
    }
  });

  test("LL-HLS tfdt is the SRT timeline plus 10 s, and W0 anchors it", async () => {
    const k = origin.get(slug) ?? (await srtOrigin(slug));
    const s = await hlsSample(`live/${slug}`);
    // The SRT pts of the frame whose strip the segment starts with.
    const srtPts = (s.strip - k) / 1000;
    expect(Math.abs(s.pts - 10 - srtPts) * 1000).toBeLessThanOrEqual(FRAME_MS);
    const w0 = await fetchW0({ hlsBase: hlsBase(), path: `live/${slug}`, password: SECRET });
    expect(w0.handler).toBe("vide");
    // W0 + SRT pts is that frame's source PDT.
    const e = s.pdtMs - s.strip;
    sourceE.set(slug, e);
    expect(Math.abs(w0.w0Ms + srtPts * 1000 - (s.strip + e))).toBeLessThanOrEqual(FRAME_MS);
  });
});

describe("ladder over SRT with W0", () => {
  const rungs: Rung[] = [{ name: "480p", height: 240, videoKbps: 500, audioKbps: 64 }, AUDIO_RUNG];

  async function ladderRun(slug: string): Promise<{ e: number[]; phaseMs: number[] }> {
    const w0 = await fetchW0({ hlsBase: hlsBase(), path: `live/${slug}`, password: SECRET });
    const args = ladderArgs({
      input: internalSrtUrl(SRT_BASE, `live/${slug}`, SECRET),
      w0Ms: w0.w0Ms,
      outputFor: (r) => internalRtspUrl(RTSP_BASE, `live/${slug}/${r}`, SECRET),
      rungs,
      encoder: "libx264",
    });
    const { name, cmd } = containerFfmpeg(args);
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    try {
      await waitFor("rung on LL-HLS", () => hlsSample(`live/${slug}/480p`), 60_000);
      const samples = await hlsSamples(`live/${slug}/480p`, 9_000);
      const k = origin.get(slug) ?? (await srtOrigin(slug));
      const eSource = sourceE.get(slug) ?? Number.NaN;
      return {
        // Rung PDT − strip, against the source's.
        e: samples.map((s) => s.pdtMs - s.strip - eSource),
        // Where each rung segment (a forced keyframe) falls on the source timeline, modulo 2 s.
        phaseMs: samples.map((s) => (((s.strip - k) % 2000) + 2000) % 2000),
      };
    } finally {
      proc.kill("SIGINT");
      removeContainer(name);
      await proc.exited;
    }
  }

  test.each([
    ["no B-frames", PLAIN],
    ["B-frames", BFRAMES],
  ])("rung PDT equals source PDT and keyframes stay on 2 s boundaries across restarts (%s)", async (_l, slug) => {
    if (!sourceE.has(slug)) {
      const s = await hlsSample(`live/${slug}`);
      sourceE.set(slug, s.pdtMs - s.strip);
    }
    const first = await ladderRun(slug);
    // A second start at another phase of the source GOP.
    await Bun.sleep(1_300);
    const second = await ladderRun(slug);
    for (const r of [first, second]) {
      expect(r.e.length).toBeGreaterThan(2);
      for (const e of r.e) expect(Math.abs(e)).toBeLessThanOrEqual(FRAME_MS);
      for (const p of r.phaseMs) expect(p).toBeLessThan(FRAME_MS + 1);
    }
    if (process.env.TEST_CLOCK_LOG)
      console.warn(
        `ladder ${slug}: rung − source PDT ms`,
        first.e,
        second.e,
        "phase ms",
        first.phaseMs,
        second.phaseMs,
      );
  });
});

describe("recorder over SRT (R4)", () => {
  test.each([
    ["no B-frames", PLAIN],
    ["B-frames", BFRAMES],
  ])("fMP4 times are the SRT timeline and W0 + time is the source PDT (%s)", async (_l, slug) => {
    const dir = mkdtempSync(join(scratch, "rec-"));
    chmodSync(dir, 0o777);
    const runId = "rtest";
    const { name, cmd } = containerFfmpeg(
      recorderArgs({
        input: internalSrtUrl(SRT_BASE, `live/${slug}`, SECRET),
        dir,
        runId,
        segmentSeconds: 2,
        aacAudio: true,
      }),
      [dir],
    );
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const w0 = await fetchW0({ hlsBase: hlsBase(), path: `live/${slug}`, password: SECRET });
    // A fresh handle per read: a Bun.file made before the file existed keeps reading it as empty.
    const playlist = {
      exists: () => Bun.file(join(dir, recorderPlaylist(runId))).exists(),
      text: () => Bun.file(join(dir, recorderPlaylist(runId))).text(),
    };
    const stderr = new Response(proc.stderr).text();
    try {
      await waitFor(
        "three recorder segments",
        async () => (await playlist.exists()) && parsePlaylist(await playlist.text()).segments.length >= 3,
        60_000,
      );
    } catch (err) {
      proc.kill("SIGKILL");
      throw new Error(`${(err as Error).message}\n${(await stderr).slice(-2000)}`);
    } finally {
      proc.kill("SIGINT");
      await proc.exited;
      removeContainer(name);
    }
    const k = origin.get(slug) ?? (await srtOrigin(slug));
    const s0 = await hlsSample(`live/${slug}`);
    const eSource = sourceE.get(slug) ?? s0.pdtMs - s0.strip;
    const segments = parsePlaylist(await playlist.text()).segments.slice(0, 3);
    const offsets: number[] = [];
    for (const seg of segments) {
      const init = new Uint8Array(readFileSync(join(dir, seg.map ?? "")));
      const bytes = new Uint8Array(readFileSync(join(dir, seg.uri.split("/").pop() ?? "")));
      const track = pdtTrack(parseInit(init));
      const frag = parseFragment(bytes).find((f) => f.trackId === track?.trackId);
      if (!track || !frag || !seg.startedAt) throw new Error("bad recorder segment");
      const t = (frag.baseDecodeTime + frag.firstCompositionOffset) / track.timescale;
      const [frame] = await decodeFrames(
        ["ffmpeg", "-hide_banner", "-loglevel", "info", "-i", "pipe:0", "-frames:v", "1", ...DECODE],
        Buffer.concat([init, bytes]),
      );
      if (!frame || frame.strip === null) throw new Error("no strip in a recorder segment");
      // Step 0.3: the recorder's sample time is the SRT pts of that frame.
      expect(Math.abs(t * 1000 - (frame.strip - k))).toBeLessThanOrEqual(FRAME_MS);
      // Anchored PDT is the source's PDT of that frame.
      expect(Math.abs(w0.w0Ms + t * 1000 - (frame.strip + eSource))).toBeLessThanOrEqual(FRAME_MS);
      offsets.push(w0.w0Ms + t * 1000 - seg.startedAt.getTime());
    }
    // ffmpeg's PDT is its own clock plus summed durations: one constant offset per run.
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(FRAME_MS);
    if (process.env.TEST_CLOCK_LOG) console.warn(`recorder ${slug}: run offset ms`, offsets);
  });
});
