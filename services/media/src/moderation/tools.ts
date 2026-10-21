// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The image primitives media's moderation uses, behind one interface so unit tests can run the
 * pipeline with fakes. Production always uses `@commonair/moderation` (ffmpeg decoding, the PDQ
 * port, PNG encoding); there is no "off" implementation.
 */
import {
  decodeImage,
  encodeImage,
  MODERATION_CONSTANTS,
  pdqHash,
  sampleVideoFrames,
  type DecodedFrame,
  type PdqHash,
} from "@commonair/moderation";

export interface FrameTools {
  /** PDQ of a PDQ_LUMA_SIZE² luma frame. */
  pdq(luma: Uint8Array): PdqHash;
  /** Decode an image to both moderation sizes. */
  decodeImage(bytes: Uint8Array): Promise<DecodedFrame>;
  /** Frames of a local video file every `everySeconds`, including t = 0. */
  sampleVideo(input: string, everySeconds: number): AsyncIterable<DecodedFrame & { atSeconds: number }>;
  /** Lossless PNG of the luma frame and of the RGB frame (sealed as evidence). */
  encodePng(frame: DecodedFrame): Promise<{ luma: Uint8Array; rgb: Uint8Array }>;
}

const { PDQ_LUMA_SIZE: L, CLASSIFIER_INPUT_SIZE: C } = MODERATION_CONSTANTS;

export function defaultFrameTools(ffmpegPath: string): FrameTools {
  const opts = { ffmpegPath };
  return {
    pdq: (luma) => pdqHash(luma, L, L),
    decodeImage: (bytes) => decodeImage(bytes, opts),
    sampleVideo: (input, everySeconds) => sampleVideoFrames(input, { ...opts, everySeconds }),
    async encodePng(frame) {
      const [luma, rgb] = await Promise.all([
        encodeImage(frame.luma, { width: L, height: L, format: "gray" }, "png", opts),
        encodeImage(frame.rgb, { width: C, height: C, format: "rgb" }, "png", opts),
      ]);
      return { luma, rgb };
    },
  };
}
