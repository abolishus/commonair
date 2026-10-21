// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ffmpeg decoding (already in the media and API images; no image library, ADR 0006 Q1). Every
 * input is scaled to raw luma PDQ_LUMA_SIZE² and raw RGB CLASSIFIER_INPUT_SIZE²×3. Evidence frames
 * are encoded as PNG (lossless); T1/T2 review frames as JPEG.
 *
 * One ffmpeg process yields both sizes of a frame through a single pipe: the filter graph splits
 * the frame, scales one branch to 512² `gray` and the other to 384² `rgb24`, splits the RGB
 * branch into its three planes, and stacks everything into one `gray` frame of
 * PACKED_WIDTH × PACKED_HEIGHT:
 *
 *   rows 0..511:    luma (512 wide), right-padded with zeroes to 1152
 *   rows 512..895:  R plane | G plane | B plane (384 wide each)
 *
 * The planes are byte-identical to separate `gray` and `rgb24` outputs (checked in the tests);
 * one pipe avoids juggling two output pipes and their deadlocks. Nothing touches disk: input
 * goes through stdin (images) or a path/URL (video), output through stdout, and error messages
 * never include ffmpeg's stderr (it can carry URLs).
 */
import { MODERATION_CONSTANTS } from "./constants.ts";
import type { DecodedFrame } from "./types.ts";

export interface FfmpegOptions {
  ffmpegPath?: string;
  /** Abort decoding after this long (default 30 s for images; no default for `sampleVideoFrames`). */
  timeoutMs?: number;
}

const L = MODERATION_CONSTANTS.PDQ_LUMA_SIZE;
const C = MODERATION_CONSTANTS.CLASSIFIER_INPUT_SIZE;
const PACKED_WIDTH = 3 * C;
const PACKED_HEIGHT = L + C;
const PACKED_BYTES = PACKED_WIDTH * PACKED_HEIGHT;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Decompression-bomb guard for uploaded images (ffmpeg's `max_pixels`). */
const MAX_INPUT_PIXELS = 64_000_000;
/** Image demuxers `decodeImage` accepts; nothing that can open other files or URLs (no playlists). */
const IMAGE_DEMUXERS = "png_pipe,jpeg_pipe,gif,gif_pipe,webp_pipe,bmp_pipe";
const VIDEO_PROTOCOLS = "file,http,https,tcp,tls,crypto,rtmp,rtsp,rtp,udp";

export class FfmpegError extends Error {
  override name = "FfmpegError";
}

const packedGraph = (pre: string) =>
  `[0:v]${pre}split=2[a][b];` +
  `[a]scale=${L}:${L}:flags=area,format=gray,pad=${PACKED_WIDTH}:${L}[l];` +
  `[b]scale=${C}:${C}:flags=area,format=rgb24,extractplanes=r+g+b[pr][pg][pb];` +
  `[pr][pg][pb]hstack=inputs=3[c];[l][c]vstack=inputs=2,format=gray[o]`;

const outputArgs = ["-map", "[o]", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"];

/** Split one packed frame into the two moderation buffers (copies; the input can be reused). */
export function unpackFrame(packed: Uint8Array): DecodedFrame {
  if (packed.length !== PACKED_BYTES) throw new FfmpegError("short frame from ffmpeg");
  const luma = new Uint8Array(L * L);
  for (let y = 0; y < L; y++) luma.set(packed.subarray(y * PACKED_WIDTH, y * PACKED_WIDTH + L), y * L);
  const rgb = new Uint8Array(C * C * 3);
  for (let y = 0; y < C; y++) {
    const row = (L + y) * PACKED_WIDTH;
    for (let x = 0; x < C; x++) {
      const o = (y * C + x) * 3;
      rgb[o] = packed[row + x] ?? 0;
      rgb[o + 1] = packed[row + C + x] ?? 0;
      rgb[o + 2] = packed[row + 2 * C + x] ?? 0;
    }
  }
  return { luma, rgb };
}

interface Run {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
  timedOut(): boolean;
}

function spawnFfmpeg(
  args: string[],
  stdin: Uint8Array | null,
  opts: FfmpegOptions | undefined,
  timeoutMs?: number,
): Run {
  const proc = Bun.spawn([opts?.ffmpegPath ?? "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", ...args], {
    stdin: stdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, timeoutMs);
  if (stdin && proc.stdin) {
    const sink = proc.stdin;
    // ffmpeg may stop reading early (bad input); a broken pipe is reported via the exit code.
    void (async () => {
      try {
        await sink.write(stdin);
        await sink.end();
      } catch {
        /* exit code decides */
      }
    })();
  }
  const exited = proc.exited.finally(() => clearTimeout(timer));
  return {
    stdout: proc.stdout,
    exited,
    kill: () => proc.kill("SIGKILL"),
    timedOut: () => timedOut,
  };
}

async function readAll(run: Run): Promise<Uint8Array> {
  const [out, code] = await Promise.all([new Response(run.stdout).arrayBuffer(), run.exited]);
  if (run.timedOut()) throw new FfmpegError("ffmpeg timed out");
  if (code !== 0) throw new FfmpegError(`ffmpeg exited with code ${code}`);
  return new Uint8Array(out);
}

/** Decode an image (first frame for GIFs). Throws on anything ffmpeg cannot decode. */
export async function decodeImage(bytes: Uint8Array, opts?: FfmpegOptions): Promise<DecodedFrame> {
  if (bytes.length === 0) throw new FfmpegError("empty image");
  const run = spawnFfmpeg(
    [
      "-protocol_whitelist",
      "pipe",
      "-format_whitelist",
      IMAGE_DEMUXERS,
      "-max_pixels",
      String(MAX_INPUT_PIXELS),
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-filter_complex",
      packedGraph(""),
      ...outputArgs,
    ],
    bytes,
    opts,
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const out = await readAll(run);
  if (out.length !== PACKED_BYTES) throw new FfmpegError("ffmpeg produced no frame");
  return unpackFrame(out);
}

/**
 * Frames of a video file or URL every `everySeconds`, in order, including t = 0 (the fps
 * filter's first output is the frame nearest the start). `atSeconds` is the sample index times
 * `everySeconds`. Breaking out of the loop kills ffmpeg. A non-zero exit throws after the
 * frames that were decoded.
 */
export function sampleVideoFrames(
  input: string,
  opts: FfmpegOptions & { everySeconds: number },
): AsyncIterable<DecodedFrame & { atSeconds: number }> {
  const every = opts.everySeconds;
  if (!(every > 0) || !Number.isFinite(every)) throw new RangeError("everySeconds must be positive");
  return {
    async *[Symbol.asyncIterator]() {
      const run = spawnFfmpeg(
        [
          "-protocol_whitelist",
          VIDEO_PROTOCOLS,
          "-i",
          input,
          "-an",
          "-filter_complex",
          packedGraph(`fps=fps=1/${every},`),
          ...outputArgs,
        ],
        null,
        opts,
        opts.timeoutMs,
      );
      const reader = run.stdout.getReader();
      let buf = new Uint8Array(PACKED_BYTES);
      let filled = 0;
      let index = 0;
      let finished = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let off = 0;
          while (off < value.length) {
            const n = Math.min(PACKED_BYTES - filled, value.length - off);
            buf.set(value.subarray(off, off + n), filled);
            filled += n;
            off += n;
            if (filled === PACKED_BYTES) {
              const frame = unpackFrame(buf);
              buf = new Uint8Array(PACKED_BYTES);
              filled = 0;
              yield { ...frame, atSeconds: index * every };
              index++;
            }
          }
        }
        const code = await run.exited;
        finished = true;
        if (run.timedOut()) throw new FfmpegError("ffmpeg timed out");
        if (code !== 0) throw new FfmpegError(`ffmpeg exited with code ${code}`);
        if (filled !== 0) throw new FfmpegError("ffmpeg ended mid-frame");
      } finally {
        if (!finished) run.kill();
        reader.releaseLock();
      }
    },
  };
}

/** Encode raw pixels (`gray` = 1 byte/pixel, `rgb` = 3) as PNG or JPEG. */
export async function encodeImage(
  pixels: Uint8Array,
  size: { width: number; height: number; format: "gray" | "rgb" },
  as: "png" | "jpeg",
  opts?: FfmpegOptions,
): Promise<Uint8Array> {
  const channels = size.format === "gray" ? 1 : 3;
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width <= 0 ||
    size.height <= 0 ||
    pixels.length !== size.width * size.height * channels
  )
    throw new RangeError("encodeImage: buffer size does not match dimensions");
  const codec =
    as === "png"
      ? ["-c:v", "png", "-pix_fmt", size.format === "gray" ? "gray" : "rgb24"]
      : ["-c:v", "mjpeg", "-q:v", "3", "-pix_fmt", "yuvj444p", "-strict", "unofficial"];
  const run = spawnFfmpeg(
    [
      "-f",
      "rawvideo",
      "-pix_fmt",
      size.format === "gray" ? "gray" : "rgb24",
      "-s",
      `${size.width}x${size.height}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      ...codec,
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    pixels,
    opts,
    opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const out = await readAll(run);
  if (out.length === 0) throw new FfmpegError("ffmpeg produced no image");
  return out;
}
