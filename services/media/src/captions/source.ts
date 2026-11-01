// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The captions worker's audio (ADR 0011 decision 6): ffmpeg reads the source over SRT with
 * `-copyts` (never RTSP), the reader the recorder uses, so its timestamps are on the source
 * timeline and `W0 + pts` is the broadcast clock (ADR 0012 A2). Output is 16 kHz mono s16le on
 * stdout, cut here into fixed chunks wrapped as WAV for whisper.
 *
 * Raw PCM carries no timestamps, so the first frame's PTS is logged once by `ashowinfo` on a
 * one-sample branch of the graph, and `aresample=async=1` pads or trims to the timestamps: sample
 * `n` of the output is then at `firstPts + n / 16000`, gaps in the source included.
 */
import type { Logger } from "@commonair/observability";
import { CHUNK_SECONDS } from "@commonair/captions";
import { internalSrtUrl } from "../ffmpeg/args.ts";
import { redact } from "../ffmpeg/redact.ts";
import { backoffDelay } from "../ffmpeg/supervisor.ts";
import type { MediaContext } from "../context.ts";
import type { MediaSessionInfo } from "../hooks.ts";
import type { CaptionsMetrics } from "./metrics.ts";

export const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
export const CHUNK_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_SECONDS;

/** One chunk of speech audio on the broadcast clock. */
export interface AudioChunk {
  startMs: number;
  endMs: number;
  /** W0 of the reader run that produced the chunk (the `X-TIMESTAMP-MAP` origin). */
  w0Ms?: number;
  /** A complete WAV file (16 kHz mono PCM). */
  wav: Uint8Array<ArrayBuffer>;
}

/** Yields chunks until `signal` aborts; restarts its reader on failure. Never throws. */
export type AudioSource = (session: MediaSessionInfo, signal: AbortSignal) => AsyncIterable<AudioChunk>;

/** The ffmpeg command line (pure, so the flags are reviewable and tested). */
export function captionsAudioArgs(input: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    // `ashowinfo` logs at info: the one line it prints is how the first PTS is learned.
    "-loglevel",
    "info",
    "-nostats",
    "-copyts",
    "-i",
    input,
    "-filter_complex",
    [
      "[0:a:0]asplit=2[main][probe]",
      "[probe]atrim=end_sample=1,ashowinfo,anullsink",
      `[main]aresample=${SAMPLE_RATE}:async=1,aformat=sample_fmts=s16:channel_layouts=mono[out]`,
    ].join(";"),
    "-map",
    "[out]",
    "-f",
    "s16le",
    "pipe:1",
  ];
}

/** `pts_time:<seconds>` from an `ashowinfo` line, or null. */
export function firstPtsFrom(line: string): number | null {
  if (!line.includes("ashowinfo")) return null;
  const m = /pts_time:(-?\d+(?:\.\d+)?)/.exec(line);
  return m ? Number(m[1]) : null;
}

/** A 44-byte WAV header plus the PCM. */
export function wavFile(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  v.setUint16(32, BYTES_PER_SAMPLE, true);
  v.setUint16(34, 16, true);
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

/** PCM held while waiting for the first PTS before the run is given up (10 s of audio, 320 KB). */
export const MAX_HELD_BYTES = SAMPLE_RATE * BYTES_PER_SAMPLE * 10;

/** The first PTS never arrived (an `ashowinfo` line ffmpeg did not print or we could not parse). */
export class OriginTimeoutError extends Error {
  constructor() {
    super("no first PTS within 10 s of audio");
    this.name = "OriginTimeoutError";
  }
}

/**
 * Cuts a PCM byte stream into chunks. `startMs` of chunk `i` is `originMs + i · CHUNK_SECONDS`;
 * the origin is set once the first PTS is known (bytes before that are held, up to
 * `MAX_HELD_BYTES`: past that `push` throws `OriginTimeoutError`, so a run that never reports its
 * PTS is restarted instead of growing without bound).
 */
export class PcmChunker {
  private buf = new Uint8Array(0);
  private index = 0;
  private origin: number | null = null;

  constructor(private readonly w0Ms?: number) {}

  setOrigin(ms: number): void {
    this.origin ??= ms;
  }

  push(bytes: Uint8Array): AudioChunk[] {
    const merged = new Uint8Array(this.buf.byteLength + bytes.byteLength);
    merged.set(this.buf);
    merged.set(bytes, this.buf.byteLength);
    this.buf = merged;
    const out: AudioChunk[] = [];
    if (this.origin === null) {
      if (this.buf.byteLength > MAX_HELD_BYTES) throw new OriginTimeoutError();
      return out;
    }
    while (this.buf.byteLength >= CHUNK_BYTES) {
      const pcm = this.buf.slice(0, CHUNK_BYTES);
      this.buf = this.buf.slice(CHUNK_BYTES);
      const startMs = this.origin + this.index * CHUNK_SECONDS * 1000;
      this.index++;
      out.push({
        startMs,
        endMs: startMs + CHUNK_SECONDS * 1000,
        wav: wavFile(pcm),
        ...(this.w0Ms === undefined ? {} : { w0Ms: this.w0Ms }),
      });
    }
    return out;
  }
}

/** Waits `ms`, or less when `signal` aborts. */
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** The production source: one ffmpeg SRT reader, restarted with backoff when it exits. */
export function ffmpegAudioSource(
  ctx: MediaContext,
  logger: Logger,
  metrics: Pick<CaptionsMetrics, "originTimeout">,
): AudioSource {
  return async function* (session, signal) {
    let attempt = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        // W0 from MediaMTX's LL-HLS, fetched fresh for this reader start (ADR 0012 A2).
        const w0Ms = await ctx.clock.w0(session.broadcastId, session.path, "captions");
        const input = internalSrtUrl(ctx.srtBase, session.path, ctx.internalSecret);
        yield* readRun(ctx.ffmpeg, captionsAudioArgs(input), w0Ms, signal, logger, ctx.internalSecret);
      } catch (err) {
        if (err instanceof OriginTimeoutError) metrics.originTimeout();
        logger.warn("captions audio reader failed", { error: redact(String(err), [ctx.internalSecret]).slice(0, 200) });
      }
      if (signal.aborted) return;
      if (Date.now() - started > 30_000) attempt = 0;
      await pause(backoffDelay(attempt++, { initialMs: 1_000, maxMs: 30_000 }), signal);
    }
  };
}

async function* readRun(
  binary: string,
  args: string[],
  w0Ms: number,
  signal: AbortSignal,
  logger: Logger,
  secret: string,
): AsyncGenerator<AudioChunk> {
  const proc = Bun.spawn([binary, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => proc.kill("SIGKILL");
  signal.addEventListener("abort", kill, { once: true });
  const chunker = new PcmChunker(w0Ms);
  // stderr: the first PTS, and the last line for the log when the reader exits.
  let lastError = "";
  const errors = (async () => {
    const dec = new TextDecoder();
    let rest = "";
    for await (const part of proc.stderr) {
      const lines = (rest + dec.decode(part, { stream: true })).split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const pts = firstPtsFrom(line);
        if (pts !== null) chunker.setOrigin(w0Ms + Math.round(pts * 1000));
        else if (line.trim() !== "") lastError = line.trim();
      }
    }
  })();
  try {
    for await (const bytes of proc.stdout) for (const chunk of chunker.push(bytes)) yield chunk;
  } finally {
    signal.removeEventListener("abort", kill);
    if (proc.exitCode === null) kill();
    await errors.catch(() => {});
    const code = await proc.exited;
    if (!signal.aborted)
      logger.warn("captions audio reader exited", { code, lastError: redact(lastError, [secret]).slice(0, 200) });
  }
}
