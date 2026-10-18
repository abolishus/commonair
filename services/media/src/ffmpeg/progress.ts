// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Parser for `ffmpeg -progress pipe:1`: blocks of `key=value` lines, each block terminated by
 * `progress=continue` or `progress=end`. Values may be `N/A`.
 */
export interface Progress {
  frame: number | null;
  fps: number | null;
  /** Output position in milliseconds. */
  outTimeMs: number | null;
  totalSizeBytes: number | null;
  bitrateKbps: number | null;
  dropFrames: number;
  dupFrames: number;
  speed: number | null;
  end: boolean;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "N/A" || v === "") return null;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function toProgress(fields: Record<string, string>): Progress {
  // out_time_us is microseconds; out_time_ms is ALSO microseconds in every ffmpeg release (a
  // long-standing naming bug), so prefer out_time_us and never trust the _ms name.
  const us = num(fields.out_time_us) ?? num(fields.out_time_ms);
  return {
    frame: num(fields.frame),
    fps: num(fields.fps),
    outTimeMs: us === null ? null : Math.round(us / 1000),
    totalSizeBytes: num(fields.total_size),
    bitrateKbps: num(fields.bitrate?.replace(/kbits\/s$/, "")),
    dropFrames: num(fields.drop_frames) ?? 0,
    dupFrames: num(fields.dup_frames) ?? 0,
    speed: num(fields.speed?.replace(/x$/, "")),
    end: fields.progress === "end",
  };
}

/** Incremental parser: feed raw stdout chunks, get a callback per completed block. */
export class ProgressParser {
  private buffer = "";
  private fields: Record<string, string> = {};

  constructor(private readonly onProgress: (p: Progress) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      this.line(line);
      nl = this.buffer.indexOf("\n");
    }
    // A runaway line without newlines must not grow without bound.
    if (this.buffer.length > 64 * 1024) this.buffer = "";
  }

  private line(line: string): void {
    const eq = line.indexOf("=");
    if (eq <= 0) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    this.fields[key] = value;
    if (key === "progress") {
      const block = this.fields;
      this.fields = {};
      this.onProgress(toProgress(block));
    }
  }
}
