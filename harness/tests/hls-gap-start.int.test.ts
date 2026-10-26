// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hls.js must start a live stream whose start fragment is an `#EXT-X-GAP` segment. MediaMTX pads
 * a new muxer's playlists with GAP segments, and a viewer held back until media's AAC copy of a
 * WHIP source is live (origin 503 "starting") always arrives at a brand-new muxer: ingest-whip's
 * intermittent "no first frame" in Chromium.
 *
 * hls.js 1.7.3 wedges there: the GAP fragment starts loading the shared init segment, the next
 * fragment's init load aborts that request, and its error handler aborts the fragment loader,
 * which by then is loading the next fragment. Before the first fragment is parsed nothing resets
 * the stream controller, so it stays in FRAG_LOADING for good while playlists keep refreshing
 * (bytes, no frame, no errors). `patches/hls.js@1.7.3.patch` fixes it; this test fails without it.
 *
 * The fixture is the shape MediaMTX serves: video and audio in separate fMP4 playlists sharing
 * one EXT-X-MAP each, live (no ENDLIST), the oldest segments GAP up to the live start position.
 * Init segments answer slowly so the GAP fragment's init request is still in flight.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { BrowserFleet, openBrowserViewers } from "../src/browser-viewer.ts";
import { type PlayerServer, startPlayerServer } from "../src/player-server.ts";

const SEGMENTS = 12;
/** hls.js starts 3 target durations (3 s) behind the end: segment 9. Everything before it and it are GAP. */
const GAPS = 10;
const INIT_DELAY_MS = 300;

let dir: string;
let media: ReturnType<typeof Bun.serve>;
let server: PlayerServer;
let fleet: BrowserFleet;

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], { stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(proc.stderr).text()}`);
}

/** fMP4 HLS with 1 s segments: one video-only and one audio-only rendition, as MediaMTX splits them. */
async function encode(out: string): Promise<void> {
  const hls = (name: string) => [
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    `${name}_init.mp4`,
    "-hls_segment_filename",
    join(out, `${name}%d.m4s`),
    join(out, `${name}.m3u8`),
  ];
  const seconds = String(SEGMENTS);
  const video = "testsrc2=size=320x180:rate=30";
  // A keyframe every second, so each 1 s segment starts with one.
  const x264 = ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30"];
  await ffmpeg(["-f", "lavfi", "-i", video, "-t", seconds, ...x264, "-sc_threshold", "0", "-an", ...hls("video")]);
  const tone = "sine=frequency=440:sample_rate=48000";
  await ffmpeg(["-f", "lavfi", "-i", tone, "-t", seconds, "-c:a", "aac", "-b:a", "64k", "-vn", ...hls("audio")]);
}

/** ffmpeg's VOD playlist rewritten as a live one whose first `GAPS` segments are GAP. */
function livePlaylist(vod: string): string {
  const lines = vod.split("\n");
  const out = ["#EXTM3U", "#EXT-X-VERSION:9", "#EXT-X-TARGETDURATION:1", "#EXT-X-MEDIA-SEQUENCE:0"];
  const map = lines.find((l) => l.startsWith("#EXT-X-MAP"));
  if (map) out.push(map);
  let index = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.startsWith("#EXTINF")) continue;
    if (index < GAPS) out.push("#EXT-X-GAP");
    out.push(line, lines[i + 1] ?? "");
    index++;
  }
  return `${out.join("\n")}\n`;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hls-gap-"));
  await encode(dir);
  const files = new Set(await readdir(dir));
  const playlists = {
    "video.m3u8": livePlaylist(await readFile(join(dir, "video.m3u8"), "utf8")),
    "audio.m3u8": livePlaylist(await readFile(join(dir, "audio.m3u8"), "utf8")),
    "index.m3u8": [
      "#EXTM3U",
      "#EXT-X-VERSION:9",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00d,mp4a.40.2",RESOLUTION=320x180,AUDIO="audio"',
      "video.m3u8",
      "",
    ].join("\n"),
  };
  const cors = { "access-control-allow-origin": "*" };
  media = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      if (name in playlists) {
        return new Response(playlists[name as keyof typeof playlists], {
          headers: { ...cors, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
        });
      }
      if (!files.has(name)) return new Response("not found", { status: 404, headers: cors });
      // Keep the GAP fragment's init request in flight while hls.js moves on to the next fragment.
      if (name.endsWith("_init.mp4")) await Bun.sleep(INIT_DELAY_MS);
      return new Response(Bun.file(join(dir, name)), { headers: { ...cors, "content-type": "video/mp4" } });
    },
  });
  server = await startPlayerServer({ apiUrl: "http://127.0.0.1:9" });
  fleet = new BrowserFleet();
}, 120_000);

afterAll(async () => {
  await fleet?.close();
  await server?.stop();
  await media?.stop(true);
  if (dir) await rm(dir, { recursive: true, force: true });
}, 60_000);

test("hls.js shows a first frame when the live start fragment is an EXT-X-GAP segment", async () => {
  const [viewer] = await openBrowserViewers({
    fleet,
    engine: "chromium",
    target: { playlistUrl: `http://127.0.0.1:${media.port}/index.m3u8` },
    count: 1,
    server,
    probeScript: server.probeScript,
  });
  if (!viewer) throw new Error("no viewer opened");
  try {
    // Two real segments are buffered within a second or two; a wedged player never gets there.
    const ttff = await viewer.waitForFirstFrame(15_000);
    expect(ttff).toBeGreaterThan(0);
  } finally {
    await viewer.stop();
  }
}, 120_000);
