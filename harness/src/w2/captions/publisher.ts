// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A streamer that speaks (ADR 0011): the speech fixture over a test pattern, published over RTMP in
 * real time. The speech starts after `leadSeconds` of silence (the captions worker takes a slot and
 * reads W0 meanwhile, so its reader is on the source before the first word) and is followed by
 * `tailSeconds` of silence, so the last words are transcribed and listed before the stream ends. The video carries the timestamp
 * strip, so a browser viewer can tell the wall-clock capture time of the frame under its playhead
 * (the cue placement check).
 */
import { videoFilter } from "../../ffmpeg.ts";
import { spawnSupervised, type Supervised } from "../../process.ts";

const WIDTH = 640;
const HEIGHT = 360;

/**
 * Publisher start to the captions reader's first sample, as measured on CI (run 41285945456:
 * 8.8 s; W0 waits for MediaMTX's LL-HLS muxer, the recorder anchored at the same time). Audio
 * before it is never read, so speech there is lost from the transcript.
 */
export const CAPTIONS_STARTUP_SECONDS = 9;
/** Silence before the speech: the start-up plus margin for a slower runner. */
export const DEFAULT_LEAD_SECONDS = 15;
/**
 * Silence after the speech: the last word's chunk (3 s) waits behind up to `MAX_PENDING` (2)
 * queued chunks and then takes its own whisper run (~3 s each on CI's two threads), all before
 * the publisher disconnects and the worker stops.
 */
export const DEFAULT_TAIL_SECONDS = 12;

export interface SpeechStreamOptions {
  /** Full RTMP publish URL including the key. */
  url: string;
  audioPath: string;
  leadSeconds?: number;
  tailSeconds?: number;
  /** Repeat the speech this many times (default 1). */
  loops?: number;
  /** Epoch ms the strip encodes at frame time 0 (default: now). */
  startEpochMs?: number;
}

/** The ffmpeg command line (pure, tested). */
export function speechStreamArgs(o: SpeechStreamOptions): string[] {
  const lead = o.leadSeconds ?? DEFAULT_LEAD_SECONDS;
  const tail = o.tailSeconds ?? DEFAULT_TAIL_SECONDS;
  const loops = Math.max(1, o.loops ?? 1);
  const realtime = ["-readrate", "1"];
  return [
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "warning",
    ...realtime,
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=30`,
    ...realtime,
    "-stream_loop",
    String(loops - 1),
    "-i",
    o.audioPath,
    "-filter_complex",
    `${videoFilter({ width: WIDTH, height: HEIGHT, startEpochMs: o.startEpochMs ?? Date.now(), timecode: false })};` +
      `[1:a]aresample=48000,adelay=${lead * 1000}:all=1,apad=pad_dur=${tail}[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    // The video runs as long as the padded audio.
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-b:v",
    "800k",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-f",
    "flv",
    o.url,
  ];
}

export interface SpeechStream {
  /** Resolves when ffmpeg exits (the padded speech ended, or `stop`). */
  readonly exited: Promise<number>;
  stop(): Promise<void>;
}

export function startSpeechStream(o: SpeechStreamOptions, name: string): SpeechStream {
  const proc: Supervised = spawnSupervised(["ffmpeg", ...speechStreamArgs(o)], { name, stopSignal: "SIGINT" });
  return {
    exited: proc.exited,
    stop: async () => {
      if (proc.running) await proc.stop(3_000);
    },
  };
}
