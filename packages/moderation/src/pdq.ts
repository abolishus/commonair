// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PDQ perceptual hashing. The algorithm is a port of ThreatExchange `pdq/` (tag hma-v1.1.7,
 * BSD-3-Clause) in `./pdq/` (those files carry Meta's copyright and a BSD-3-Clause header,
 * ADR 0008); this file is the package's API over it.
 */
import { floatLumaFromGrey, floatLumaFromRGB, formatHash256, pdqHash256FromFloatLuma } from "./pdq/hashing.ts";
import type { PdqHash } from "./types.ts";

export const PDQ_HEX = /^[0-9a-f]{64}$/;

function checkSize(bytes: Uint8Array, width: number, height: number, channels: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0)
    throw new RangeError("pdq: width and height must be non-negative integers");
  if (bytes.length !== width * height * channels) throw new RangeError("pdq: buffer size does not match dimensions");
}

/** PDQ of a raw 8-bit luma image of any size (the reference algorithm's float path). */
export function pdqHash(luma: Uint8Array, width: number, height: number): PdqHash {
  checkSize(luma, width, height, 1);
  const buf1 = floatLumaFromGrey(luma, height, width);
  const { hash, quality } = pdqHash256FromFloatLuma(buf1, new Float32Array(buf1.length), height, width);
  return { hash: formatHash256(hash), quality };
}

/**
 * PDQ of raw packed RGB (3 bytes per pixel), with the reference's RGB → luma conversion
 * (0.299 R + 0.587 G + 0.114 B in float). Used for the reference vectors; the services hash
 * ffmpeg's 8-bit luma with `pdqHash`.
 */
export function pdqHashRgb(rgb: Uint8Array, width: number, height: number): PdqHash {
  checkSize(rgb, width, height, 3);
  const buf1 = floatLumaFromRGB(rgb, height, width);
  const { hash, quality } = pdqHash256FromFloatLuma(buf1, new Float32Array(buf1.length), height, width);
  return { hash: formatHash256(hash), quality };
}

/** Hex of 64 lowercase characters as eight 32-bit words, for popcount. */
export function hashWords(hex: string, out: Uint32Array = new Uint32Array(8), offset = 0): Uint32Array {
  if (!PDQ_HEX.test(hex)) throw new TypeError("pdq: malformed hash");
  for (let i = 0; i < 8; i++) out[offset + i] = Number.parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return out;
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

/** Hamming distance of two 64-hex PDQ hashes (0–256). Throws on malformed input. */
export function hammingDistance(a: string, b: string): number {
  const wa = hashWords(a);
  const wb = hashWords(b);
  let d = 0;
  for (let i = 0; i < 8; i++) d += popcount32(((wa[i] ?? 0) ^ (wb[i] ?? 0)) >>> 0);
  return d;
}
