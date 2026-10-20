// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ffmpeg decoding (already in the media and API images; no image library, ADR 0006 Q1). Every
 * input is scaled to raw luma PDQ_LUMA_SIZE² and raw RGB CLASSIFIER_INPUT_SIZE²×3. Evidence frames
 * are encoded as PNG (lossless); T1/T2 review frames as JPEG.
 */
import { pending } from "./pending.ts";
import type { DecodedFrame } from "./types.ts";

export interface FfmpegOptions {
  ffmpegPath?: string;
  /** Abort decoding after this long (default 30 s). */
  timeoutMs?: number;
}

/** Decode an image (first frame for GIFs). Throws on anything ffmpeg cannot decode. */
export async function decodeImage(_bytes: Uint8Array, _opts?: FfmpegOptions): Promise<DecodedFrame> {
  return pending("decodeImage");
}

/** Frames of a video file or URL every `everySeconds`, in order, including t = 0. */
export function sampleVideoFrames(
  _input: string,
  _opts: FfmpegOptions & { everySeconds: number },
): AsyncIterable<DecodedFrame & { atSeconds: number }> {
  return pending("sampleVideoFrames");
}

/** Encode raw pixels (`gray` = 1 byte/pixel, `rgb` = 3) as PNG or JPEG. */
export async function encodeImage(
  _pixels: Uint8Array,
  _size: { width: number; height: number; format: "gray" | "rgb" },
  _as: "png" | "jpeg",
  _opts?: FfmpegOptions,
): Promise<Uint8Array> {
  return pending("encodeImage");
}
