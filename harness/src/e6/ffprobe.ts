// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Did frames arrive at the mock simulcast target? `ffprobe -count_frames` reads the target's RTMP
 * path for a bounded time and reports the video frames it decoded and their size. The URL carries
 * the run's simulcast key (the mock target's path), so it is never logged or reported: errors say
 * only that the probe failed.
 */
import { withTimeout } from "../wait.ts";

export interface FrameProbe {
  /** Video frames read (0 when nothing was published or the probe failed). */
  frames: number;
  width: number | null;
  height: number | null;
  /** ffprobe exit code (null when it was killed on the outer timeout). */
  exitCode: number | null;
}

/** The mock target's read URL for a key (`MOCK_RTMP_PORT`, default 1936). */
export function mockRtmpReadUrl(key: string, port: number | string = 1936, host = "localhost"): string {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error("simulcast key must be URL-safe");
  return `rtmp://${host}:${port}/live/${key}`;
}

/** `MOCK_RTMP_PORT` from the environment (the repo `.env` Bun loads), else 1936. */
export function mockRtmpPort(env: Record<string, string | undefined> = process.env): number {
  const v = env.MOCK_RTMP_PORT?.trim();
  const n = v ? Number(v) : 1936;
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error("MOCK_RTMP_PORT must be a TCP port");
  return n;
}

/** ffprobe arguments: read `seconds` of the first video stream and count its frames. */
export function ffprobeFrameArgs(url: string, seconds: number, rwTimeoutSeconds = 8): string[] {
  if (!(seconds > 0)) throw new RangeError("seconds must be positive");
  return [
    "-v",
    "error",
    "-rw_timeout",
    String(Math.round(rwTimeoutSeconds * 1_000_000)),
    "-select_streams",
    "v:0",
    "-count_frames",
    "-read_intervals",
    `%+${seconds}`,
    "-show_entries",
    "stream=nb_read_frames,width,height",
    "-of",
    "json",
    url,
  ];
}

/** Parse ffprobe's JSON (`streams[0].nb_read_frames`, `width`, `height`). Garbage → 0 frames. */
export function parseFrameProbe(stdout: string, exitCode: number | null): FrameProbe {
  let parsed: { streams?: { nb_read_frames?: unknown; width?: unknown; height?: unknown }[] } = {};
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return { frames: 0, width: null, height: null, exitCode };
  }
  const s = parsed.streams?.[0];
  const n = Number(s?.nb_read_frames);
  const dim = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  return {
    frames: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    width: dim(s?.width),
    height: dim(s?.height),
    exitCode,
  };
}

function spawnProbe(binary: string, args: string[]) {
  return Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
}

/** Run ffprobe against `url` for `seconds`; never throws for a missing publisher (0 frames). */
export async function probeFrames(url: string, seconds: number, binary = "ffprobe"): Promise<FrameProbe> {
  const args = ffprobeFrameArgs(url, seconds);
  let proc: ReturnType<typeof spawnProbe>;
  try {
    proc = spawnProbe(binary, args);
  } catch {
    // ffprobe missing: the scenario's `ffmpeg` need covers the install; report "no frames".
    return { frames: 0, width: null, height: null, exitCode: null };
  }
  try {
    const [stdout, code] = await withTimeout(
      "ffprobe frame count",
      Promise.all([new Response(proc.stdout).text(), proc.exited]),
      (seconds + 20) * 1000,
    );
    return parseFrameProbe(stdout, code);
  } catch {
    return { frames: 0, width: null, height: null, exitCode: null };
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
}
