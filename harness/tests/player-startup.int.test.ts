// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The harness player records its start-up timeline from real hls.js events: playing a live stream
 * shaped like a new MediaMTX muxer (separate fMP4 video and audio playlists, GAP segments up to the
 * live start), the report names each milestone up to the first frame and the GAP fragments hls.js
 * skipped on the way. This is what an ingest-whip TTFF failure will carry (flakes.md).
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { formatStartup } from "../player/startup.ts";
import { BrowserFleet, openBrowserViewers } from "../src/browser-viewer.ts";
import { type PlayerServer, startPlayerServer } from "../src/player-server.ts";

const SEGMENTS = 12;
/** hls.js starts 3 target durations behind the end (segment 9): it and everything before it are GAP. */
const GAPS = 10;

let dir: string;
let media: ReturnType<typeof Bun.serve>;
let server: PlayerServer;
let fleet: BrowserFleet;

async function ffmpeg(args: string[]): Promise<void> {
  const proc = Bun.spawn(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", ...args], { stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed: ${await new Response(proc.stderr).text()}`);
}

function hlsArgs(out: string, name: string): string[] {
  const segments = join(out, `${name}%d.m4s`);
  const fmp4 = ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", `${name}_init.mp4`];
  return [
    "-f",
    "hls",
    "-hls_time",
    "1",
    "-hls_list_size",
    "0",
    ...fmp4,
    "-hls_segment_filename",
    segments,
    join(out, `${name}.m3u8`),
  ];
}

/** ffmpeg's VOD playlist as a live one whose first `GAPS` segments are GAP. */
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
  dir = await mkdtemp(join(tmpdir(), "player-startup-"));
  const seconds = String(SEGMENTS);
  // A keyframe every second, so each 1 s segment starts with one.
  const x264 = ["-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-g", "30", "-keyint_min", "30"];
  const video = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", seconds];
  await ffmpeg([...video, ...x264, "-sc_threshold", "0", "-an", ...hlsArgs(dir, "video")]);
  const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", seconds];
  await ffmpeg([...tone, "-c:a", "aac", "-b:a", "64k", "-vn", ...hlsArgs(dir, "audio")]);
  const files = new Set(await readdir(dir));
  const playlists: Record<string, string> = {
    "video.m3u8": livePlaylist(await readFile(join(dir, "video.m3u8"), "utf8")),
    "audio.m3u8": livePlaylist(await readFile(join(dir, "audio.m3u8"), "utf8")),
    "index.m3u8": [
      "#EXTM3U",
      "#EXT-X-VERSION:9",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",AUTOSELECT=YES,DEFAULT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00d,mp4a.40.2",RESOLUTION=320x180,AUDIO="audio"',
      "video.m3u8?t=SECRET",
      "",
    ].join("\n"),
  };
  const cors = { "access-control-allow-origin": "*" };
  media = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      const playlist = playlists[name];
      if (playlist !== undefined) {
        return new Response(playlist, {
          headers: { ...cors, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
        });
      }
      if (!files.has(name)) return new Response("not found", { status: 404, headers: cors });
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

test("the report carries hls.js's start-up milestones and the GAP fragments before the first frame", async () => {
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
    await viewer.waitForFirstFrame(15_000);
    const { startup } = await viewer.report();
    if (!startup) throw new Error("no start-up timeline in the report");
    const names = startup.events.map((e) => e.event);
    // mode=direct starts no playback session.
    expect(new Set(names)).toEqual(
      new Set(["manifest", "level-video", "level-audio", "frag-video", "frag-audio", "first-frame"]),
    );
    expect(names.at(-1)).toBe("first-frame");
    const at = (name: string) => startup.events.find((e) => e.event === name)?.at ?? Number.NaN;
    expect(at("manifest")).toBeLessThanOrEqual(at("level-video"));
    expect(at("level-video")).toBeLessThanOrEqual(at("frag-video"));
    for (const e of startup.events) expect(e.at).toBeLessThanOrEqual(at("first-frame"));
    const video = startup.events.find((e) => e.event === "frag-video");
    expect(video?.sn).toEqual(expect.any(Number));
    expect(video?.gap).toBe(false);
    // hls.js skips the live start's GAP segment with a non-fatal fragGap error.
    expect(startup.nonFatal.some((e) => e.details === "fragGap")).toBe(true);
    expect(JSON.stringify(startup)).not.toContain("SECRET");
    expect(formatStartup(startup)).toContain("first-frame@");
    // Frozen at the first frame: a later report says the same.
    await Bun.sleep(1_500);
    expect((await viewer.report()).startup).toEqual(startup);
  } finally {
    await viewer.stop();
  }
}, 120_000);
