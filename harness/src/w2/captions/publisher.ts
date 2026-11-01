// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A streamer that speaks (ADR 0011): the speech fixture over a test pattern, published over RTMP in
 * real time. The speech starts after `leadSeconds` of silence (the captions worker takes a slot,
 * reads W0 and cuts its first chunk meanwhile) and is followed by `tailSeconds` of silence, so the
 * last words land in a finished chunk before the stream ends.
 */
import { spawnSupervised, type Supervised } from "../../process.ts";

export interface SpeechStreamOptions {
  /** Full RTMP publish URL including the key. */
  url: string;
  audioPath: string;
  leadSeconds?: number;
  tailSeconds?: number;
  /** Repeat the speech this many times (default 1). */
  loops?: number;
}

/** The ffmpeg command line (pure, tested). */
export function speechStreamArgs(o: SpeechStreamOptions): string[] {
  const lead = o.leadSeconds ?? 6;
  const tail = o.tailSeconds ?? 8;
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
    "testsrc2=size=640x360:rate=30",
    ...realtime,
    "-stream_loop",
    String(loops - 1),
    "-i",
    o.audioPath,
    "-filter_complex",
    `[1:a]aresample=48000,adelay=${lead * 1000}:all=1,apad=pad_dur=${tail}[a]`,
    "-map",
    "0:v",
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
