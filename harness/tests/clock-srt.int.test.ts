// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ADR 0012 A2 with a WHIP source: the media service reads every source over SRT, so a WebRTC
 * publisher's Opus must survive MediaMTX's MPEG-TS for the AAC copy to re-encode it, and SRT
 * readers of a WHIP path must share one timeline like RTMP ones do (the media package pins the
 * RTMP side against the production config). SRT readers run the compose image's ffmpeg in a
 * container on MediaMTX's network namespace, so the host ffmpeg needs no SRT.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { CONTAINER_FFMPEG_IMAGE, whipFfmpeg } from "../src/ffmpeg.ts";
import { Streamer } from "../src/streamer.ts";
import { MEDIAMTX_IMAGE, podmanAvailable, startMediaMtx, type MediaMtxInstance } from "../src/testing/mediamtx.ts";
import { decodeStrip, graySource } from "../src/timestamp-strip.ts";

const PATH = `live/clk_${crypto.randomUUID().slice(0, 8)}`;
const FRAME_MS = 1000 / 30;
const W = 320;
const H = 180;

let mtx: MediaMtxInstance;
let whip: Streamer | null = null;
const names = new Set<string>();

const skip = !(await podmanAvailable()) || (await whipFfmpeg()) === null;

/** ffmpeg from the compose image, on MediaMTX's network namespace (SRT on 127.0.0.1:8890). */
function srtFfmpeg(args: string[]): string[] {
  const name = `harness-mediamtx-ff-${crypto.randomUUID().slice(0, 8)}`;
  names.add(name);
  return [
    "podman",
    "run",
    "--rm",
    "-i",
    "--name",
    name,
    "--network",
    `container:${mtx.name}`,
    "--entrypoint",
    "ffmpeg",
    CONTAINER_FFMPEG_IMAGE,
    ...args,
  ];
}

const SRT_IN = ["-copyts", "-i", `srt://127.0.0.1:8890?streamid=read:${PATH}`];

async function run(cmd: string[]): Promise<{ out: Uint8Array; err: string }> {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
  await p.exited;
  return { out: new Uint8Array(out), err };
}

/** `strip − pts` (ms) of one SRT reader session's frames. */
async function sessionOrigin(): Promise<number> {
  const { out, err } = await run(
    srtFfmpeg([
      "-hide_banner",
      "-loglevel",
      "info",
      ...SRT_IN,
      "-frames:v",
      "12",
      "-fps_mode",
      "passthrough",
      "-vf",
      `showinfo,scale=${W}:${H},format=gray`,
      "-f",
      "rawvideo",
      "pipe:1",
    ]),
  );
  const pts = [...err.matchAll(/pts_time:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const origins: number[] = [];
  for (let i = 0; i < Math.min(pts.length, Math.floor(out.length / (W * H))); i++) {
    const strip = decodeStrip(graySource(out.subarray(i * W * H, (i + 1) * W * H), W, H));
    if (strip !== null) origins.push(strip - (pts[i] ?? Number.NaN) * 1000);
  }
  if (origins.length < 3) throw new Error(`too few strips decoded over SRT: ${err.slice(-1500)}`);
  expect(Math.max(...origins) - Math.min(...origins)).toBeLessThan(2);
  return origins[0] ?? Number.NaN;
}

beforeAll(async () => {
  if (skip) return;
  mtx = await startMediaMtx();
  whip = new Streamer({
    protocol: "whip",
    url: mtx.whipEndpoint(PATH),
    bearer: "harness-test",
    width: 640,
    height: 360,
    bitrateKbps: 1000,
    keyframeIntervalSeconds: 2,
  });
  await whip.start();
  await mtx.waitForPath(PATH, 30_000);
}, 120_000);

afterAll(async () => {
  await whip?.stop().catch(() => undefined);
  for (const name of names)
    Bun.spawnSync(["podman", "rm", "-f", "-t", "1", name], { stdout: "ignore", stderr: "ignore" });
  await mtx?.stop();
  // Container removal takes longer than the default 10 s while the gate's other tests run.
}, 60_000);

test("the helper's MediaMTX is the version compose runs", () => {
  const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
  const versions = [...compose.matchAll(/bluenviron\/mediamtx:([0-9.]+)/g)].map((m) => m[1]);
  expect(versions.length).toBeGreaterThan(0);
  const helper = /bluenviron\/mediamtx:([0-9.]+)/.exec(MEDIAMTX_IMAGE)?.[1];
  for (const v of versions) expect(v).toBe(helper);
});

describe.skipIf(skip)("WHIP source read over SRT", () => {
  test("keeps an Opus track that ffmpeg re-encodes to AAC", async () => {
    const probe = await run(srtFfmpeg(["-hide_banner", ...SRT_IN, "-t", "1", "-f", "null", "-"]));
    expect(probe.err).toMatch(/Audio: opus/);
    // What the AAC copy does: 5 s of the Opus track to AAC, counted as packets.
    const enc = await run(
      srtFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        ...SRT_IN,
        "-map",
        "0:a:0",
        // Not `-t 5`: under -copyts output times start where the source timeline is, not at 0.
        "-frames:a",
        "235",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-f",
        "framecrc",
        "pipe:1",
      ]),
    );
    // framecrc: `stream, dts, pts, duration, size, crc` in 1/48000.
    const packets = new TextDecoder()
      .decode(enc.out)
      .split("\n")
      .filter((l) => /^\s*0,/.test(l))
      .map((l) => l.split(",").map((f) => Number.parseInt(f.trim(), 10)));
    // 48 kHz AAC: 1024 samples per packet, 235 ≈ 5 s.
    // (The encoder may flush a packet or two past the frame limit.)
    expect(packets.length, enc.err.slice(-1500)).toBeGreaterThanOrEqual(235);
    expect(packets.length).toBeLessThan(240);
    expect(packets.every((p) => (p[4] ?? 0) > 0)).toBe(true);
    const span = ((packets.at(-1)?.[2] ?? 0) - (packets[0]?.[2] ?? 0)) / 48_000;
    expect(span).toBeGreaterThan(4.9);
    expect(span).toBeLessThan(5.1);
  }, 90_000);

  test("every -copyts SRT reader session of a WHIP path sees one timeline", async () => {
    const origins: number[] = [];
    for (let i = 0; i < 3; i++) {
      origins.push(await sessionOrigin());
      await Bun.sleep(1_500);
    }
    expect(Math.max(...origins) - Math.min(...origins)).toBeLessThanOrEqual(FRAME_MS);
  }, 120_000);
});
