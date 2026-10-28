// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W0 of a WHIP source from its first seconds (ADR 0012 A2; the clock-skew failure of 2026-10-28).
 *
 * MediaMTX stamps a WebRTC path's LL-HLS PDT from arrival (its NTP estimator, re-anchored to the
 * arrival time whenever media would land in the future). The harness streamer's ffmpeg starts its
 * `-re` clock before the WHIP handshake is done, so it starts ~1.5 s behind and catches up at
 * `-readrate_catchup`'s default 1.05× for ~30 s: PDT moves about 95 ms per 2 s segment against
 * the stream timeline, which does not move (with `-readrate_catchup 1` W0 is constant from the
 * second segment on, measured). A W0 read in that window is off by however far the publisher
 * still had to catch up: the AAC copy, started at publish, kept a W0 a second away from the one
 * the ladder and recorder read later. `fetchW0` must refuse W0 until the PDT has settled, and an
 * AAC copy started on the first W0 it accepts must carry the source's settled PDT.
 *
 * Uses the harness MediaMTX (WHIP over loopback UDP, SRT published) and its WebRTC streamer; the
 * AAC copy runs `aacCopyArgs` in the media image (or MediaMTX's ffmpeg image) on MediaMTX's
 * network namespace.
 */
import { afterAll, beforeAll, expect, test, vi } from "vite-plus/test";
import { CONTAINER_FFMPEG_IMAGE, whipFfmpeg } from "../../../harness/src/ffmpeg.ts";
import { Streamer } from "../../../harness/src/streamer.ts";
import { podmanAvailable, startMediaMtx, type MediaMtxInstance } from "../../../harness/src/testing/mediamtx.ts";
import { decodeStrip, graySource } from "../../../harness/src/timestamp-strip.ts";
import { parseFragment, parseInit } from "../src/clock/boxes.ts";
import { fetchW0, firstVariant, HLS_TFDT_OFFSET_SECONDS, newestSegment, pdtTrack } from "../src/clock/w0.ts";
import { aacCopyArgs, internalRtspUrl, internalSrtUrl } from "../src/ffmpeg/args.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

if (!(await podmanAvailable())) throw new Error("media integration tests need podman (rootless is fine)");
if ((await whipFfmpeg()) === null) throw new Error("no ffmpeg with the WHIP muxer (local or the MediaMTX image)");

const SLUG = `clkw_${crypto.randomUUID().slice(0, 8)}`;
const PATH = `live/${SLUG}`;
const AAC_PATH = `${PATH}/aac`;
/** The harness MediaMTX lets anyone read; the SRT streamid still needs a secret without ':'. */
const SECRET = "harness";
const FRAME_MS = 1000 / 30;
/** How long the run watches: past the estimator's convergence (~25 s), with margin. */
const WATCH_MS = 45_000;
const W = 320;
const H = 180;

function podman(args: string[]): number {
  return Bun.spawnSync(["podman", ...args], { stdout: "ignore", stderr: "ignore" }).exitCode ?? 1;
}
const FFMPEG_IMAGE =
  podman(["image", "exists", "localhost/commonair/media:dev"]) === 0
    ? "localhost/commonair/media:dev"
    : CONTAINER_FFMPEG_IMAGE;

let mtx: MediaMtxInstance;
let whip: Streamer | null = null;
let copy: Bun.Subprocess | null = null;
const copyName = `media-int-clockw-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  mtx = await startMediaMtx();
});

afterAll(async () => {
  copy?.kill("SIGKILL");
  podman(["rm", "-f", "-t", "1", copyName]);
  await whip?.stop().catch(() => undefined);
  await mtx?.stop();
});

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function firstStrip(init: Uint8Array, segment: Uint8Array): Promise<number | null> {
  const p = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-frames:v", "1"].concat([
      "-vf",
      `scale=${W}:${H},format=gray`,
      "-f",
      "rawvideo",
      "pipe:1",
    ]),
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  void p.stdin.write(Buffer.concat([init, segment]));
  await p.stdin.end();
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  await p.exited;
  return out.length < W * H ? null : decodeStrip(graySource(out.subarray(0, W * H), W, H));
}

interface Sample {
  uri: string;
  pdtMs: number;
  /** W0 from this one segment, as the pre-fix `fetchW0` read it. */
  w0Ms: number;
  /** PDT − the strip of the segment's first frame. */
  e: number | null;
}

/** The newest complete segment of a path: its own W0 and its PDT against the burned-in strip. */
async function sample(path: string): Promise<Sample> {
  const mvUrl = mtx.hlsPlaylist(path);
  const mv = new TextDecoder().decode(await get(mvUrl));
  const variant = firstVariant(mv);
  const mediaUrl = variant ? new URL(variant, mvUrl).toString() : mvUrl;
  const seg = newestSegment(variant ? new TextDecoder().decode(await get(mediaUrl)) : mv);
  if (!seg) throw new Error(`no complete segment on ${path}`);
  const init = await get(new URL(seg.map, mediaUrl).toString());
  const bytes = await get(new URL(seg.uri, mediaUrl).toString());
  const track = pdtTrack(parseInit(init));
  const frag = parseFragment(bytes).find((f) => f.trackId === track?.trackId);
  if (!track || !frag) throw new Error("no PDT track fragment");
  const pts = (frag.baseDecodeTime + frag.firstCompositionOffset) / track.timescale - HLS_TFDT_OFFSET_SECONDS;
  const strip = await firstStrip(init, bytes);
  return {
    uri: seg.uri.split("?")[0] ?? seg.uri,
    pdtMs: seg.pdtMs,
    w0Ms: seg.pdtMs - pts * 1000,
    e: strip === null ? null : seg.pdtMs - strip,
  };
}

test("fetchW0 refuses a WHIP path's W0 until its PDT settles, and an AAC copy started on it has the source's PDT", async () => {
  whip = new Streamer({
    protocol: "whip",
    url: mtx.whipEndpoint(PATH),
    bearer: "harness-test",
    width: 640,
    height: 360,
    bitrateKbps: 1000,
    keyframeIntervalSeconds: 2,
  });
  const t0 = Date.now();
  await whip.start();
  await mtx.waitForPath(PATH, 30_000);

  const raw = new Map<string, Sample & { t: number }>();
  const accepted: { t: number; w0Ms: number }[] = [];
  while (Date.now() - t0 < WATCH_MS) {
    const s = await sample(PATH).catch(() => null);
    if (s && !raw.has(s.uri)) raw.set(s.uri, { ...s, t: Date.now() - t0 });
    const w0 = await fetchW0({ hlsBase: mtx.hlsUrl, path: PATH, password: SECRET }).catch(() => null);
    if (w0) {
      accepted.push({ t: Date.now() - t0, w0Ms: w0.w0Ms });
      // What the media service does: start the AAC copy on the first W0 it gets.
      if (!copy)
        copy = Bun.spawn(
          [
            "podman",
            "run",
            "--rm",
            "--name",
            copyName,
            "--network",
            `container:${mtx.name}`,
            "--entrypoint",
            "ffmpeg",
            FFMPEG_IMAGE,
            ...aacCopyArgs(
              internalSrtUrl("srt://127.0.0.1:8890", PATH, SECRET),
              internalRtspUrl("rtsp://127.0.0.1:8554", AAC_PATH, SECRET),
              w0.w0Ms,
            ),
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        );
    }
    await Bun.sleep(500);
  }

  const series = [...raw.values()];
  const settled = series.at(-1)?.w0Ms ?? Number.NaN;
  const report = () =>
    JSON.stringify({
      raw: series.map((s) => [Math.round(s.t / 100) / 10, Math.round(s.w0Ms - settled), s.e]),
      accepted: accepted.map((a) => [Math.round(a.t / 100) / 10, Math.round(a.w0Ms - settled)]),
    });
  if (process.env.TEST_CLOCK_LOG) console.warn(`whip W0 ms vs settled (t s, Δ, PDT − strip): ${report()}`);

  // The AAC copy's PDT is the source's, frame for frame (its video is copied, strip included).
  const pairs: number[] = [];
  const deadline = Date.now() + 20_000;
  while (pairs.length < 4 && Date.now() < deadline) {
    const [src, aac] = await Promise.all([sample(PATH).catch(() => null), sample(AAC_PATH).catch(() => null)]);
    if (typeof src?.e === "number" && typeof aac?.e === "number") pairs.push(aac.e - src.e);
    await Bun.sleep(1_000);
  }
  if (process.env.TEST_CLOCK_LOG) console.warn(`whip AAC copy − source PDT ms: ${JSON.stringify(pairs)}`);

  // The source settles: its last segments agree on W0.
  if (series.length <= 8) {
    // Nothing (or little) to judge: say why, from MediaMTX and the streamer.
    const logs = (await mtx.logs()).split("\n").slice(-40).join("\n");
    throw new Error(`${report()}\nstreamer: ${whip.stderr().slice(-10).join("\n")}\nmediamtx:\n${logs}`);
  }
  for (const s of series.slice(-3)) expect(Math.abs(s.w0Ms - settled), report()).toBeLessThanOrEqual(FRAME_MS / 4);
  // W0 is accepted (well before the end of the watch) and never off the settled value.
  expect(accepted.length, report()).toBeGreaterThan(0);
  expect(accepted[0]?.t ?? Infinity, report()).toBeLessThan(WATCH_MS - 10_000);
  for (const a of accepted) expect(Math.abs(a.w0Ms - settled), report()).toBeLessThanOrEqual(FRAME_MS);

  expect(pairs.length, report()).toBeGreaterThan(2);
  for (const d of pairs) expect(Math.abs(d), `${JSON.stringify(pairs)} ${report()}`).toBeLessThanOrEqual(FRAME_MS);
});
