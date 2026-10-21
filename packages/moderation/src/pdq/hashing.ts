// SPDX-FileCopyrightText: Meta Platforms, Inc. and affiliates.
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Port of ThreatExchange `pdq/cpp/hashing/pdqhashing.cpp`, `pdq/cpp/hashing/torben.cpp` and the
 * `Hash256` bit layout and hex format of `pdq/cpp/common/pdqhashtypes.{h,cpp}`, tag hma-v1.1.7.
 * Algorithm description: `pdqhash-2017-10-09.pdf` in the ThreatExchange repository.
 *
 * Float semantics as in `downscaling.ts`: `Float32Array` storage and `Math.fround` on every
 * intermediate, with no fused multiply-add (the reference's expected outputs come from x86-64
 * builds without FMA).
 */
import {
  computeJaroszFilterWindowSize,
  decimateFloat,
  fillFloatLumaFromGrey,
  fillFloatLumaFromRGB,
  jaroszFilterFloat,
} from "./downscaling.ts";

const f = Math.fround;

/** Smaller inputs hash to all zeroes with quality 0, as in the reference. */
export const MIN_HASHABLE_DIM = 5;
/** Two X/Y passes make the box filter a tent filter. */
const PDQ_NUM_JAROSZ_XY_PASSES = 2;

/**
 * The 16×64 DCT matrix (rows 1..16 of the 64-point DCT-II), row-major. As in the reference the
 * cosine is taken in double, multiplied by the float scale factor in double, and stored as float.
 */
const DCT_MATRIX_64 = (() => {
  const numRows = 16;
  const numCols = 64;
  const scale = f(Math.sqrt(2.0 / numCols));
  const m = new Float32Array(numRows * numCols);
  for (let i = 0; i < numRows; i++) {
    for (let j = 0; j < numCols; j++) {
      m[i * numCols + j] = scale * Math.cos((Math.PI / 2.0 / numCols) * (i + 1) * (2 * j + 1));
    }
  }
  return m;
})();

/** A 256-bit hash as sixteen 16-bit words; bit k is bit (k & 15) of word k >> 4. */
export type Hash256 = Uint16Array;

export const newHash256 = (): Hash256 => new Uint16Array(16);

const setBit = (h: Hash256, k: number) => {
  const w = (k & 255) >> 4;
  h[w] = (h[w] ?? 0) | (1 << (k & 15));
};

/** The reference's `%04hx` × 16 format, most significant word (w[15]) first. */
export function formatHash256(h: Hash256): string {
  let s = "";
  for (let w = 15; w >= 0; w--) s += (h[w] ?? 0).toString(16).padStart(4, "0");
  return s;
}

/**
 * Hash and quality of a luma image (`Float32Array`, row-major). `fullBuffer1` is overwritten
 * (blurred in place), `fullBuffer2` is scratch of the same size. Returns the 16×16 DCT output.
 */
export function pdqFloat256FromFloatLuma(
  fullBuffer1: Float32Array,
  fullBuffer2: Float32Array,
  numRows: number,
  numCols: number,
): { dct16x16: Float32Array; quality: number } {
  const buffer64x64 = new Float32Array(64 * 64);
  if (numRows === 64 && numCols === 64) {
    // E.g. video frames already downsampled by ffmpeg.
    buffer64x64.set(fullBuffer1.subarray(0, 64 * 64));
  } else {
    const windowSizeAlongRows = computeJaroszFilterWindowSize(numCols, 64);
    const windowSizeAlongCols = computeJaroszFilterWindowSize(numRows, 64);
    jaroszFilterFloat(
      fullBuffer1,
      fullBuffer2,
      numRows,
      numCols,
      windowSizeAlongRows,
      windowSizeAlongCols,
      PDQ_NUM_JAROSZ_XY_PASSES,
    );
    decimateFloat(fullBuffer1, numRows, numCols, buffer64x64, 64, 64);
  }
  // Quality reuses the 64x64 image-domain downsample.
  const quality = pdqImageDomainQualityMetric(buffer64x64);
  const dct16x16 = new Float32Array(16 * 16);
  dct64To16(buffer64x64, new Float32Array(16 * 64), dct16x16);
  return { dct16x16, quality };
}

/**
 * Heuristic gradient count (see the PDQ document): quantized differences between neighbours,
 * so only significant gradients count; capped at 100.
 */
export function pdqImageDomainQualityMetric(buffer64x64: Float32Array): number {
  let gradientSum = 0;
  for (let i = 0; i < 63; i++) {
    for (let j = 0; j < 64; j++) {
      const u = buffer64x64[i * 64 + j] ?? 0;
      const v = buffer64x64[(i + 1) * 64 + j] ?? 0;
      const d = Math.trunc(f(f(f(u - v) * 100) / 255));
      gradientSum += Math.abs(d);
    }
  }
  for (let i = 0; i < 64; i++) {
    for (let j = 0; j < 63; j++) {
      const u = buffer64x64[i * 64 + j] ?? 0;
      const v = buffer64x64[i * 64 + j + 1] ?? 0;
      const d = Math.trunc(f(f(f(u - v) * 100) / 255));
      gradientSum += Math.abs(d);
    }
  }
  return Math.min(100, Math.trunc(gradientSum / 90));
}

/**
 * B = D A Dᵀ for slots 1..16 only, with T = D A as the intermediate. Summation order matches
 * the reference (k ascending), which matters for float rounding.
 */
export function dct64To16(A: Float32Array, T: Float32Array, B: Float32Array): void {
  const D = DCT_MATRIX_64;
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 64; j++) {
      let sumk = 0;
      for (let k = 0; k < 64; k++) sumk = f(sumk + f((D[i * 64 + k] ?? 0) * (A[k * 64 + j] ?? 0)));
      T[i * 64 + j] = sumk;
    }
  }
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      let sumk = 0;
      for (let k = 0; k < 64; k++) sumk = f(sumk + f((T[i * 64 + k] ?? 0) * (D[j * 64 + k] ?? 0)));
      B[i * 16 + j] = sumk;
    }
  }
}

/** Torben Mogensen's median (public-domain algorithm and implementation by N. Devillard). */
export function torben(m: Float32Array, n: number): number {
  let min = m[0] ?? 0;
  let max = min;
  for (let i = 1; i < n; i++) {
    const x = m[i] ?? 0;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  let less = 0;
  let greater = 0;
  let equal = 0;
  let guess = 0;
  let maxltguess = min;
  let mingtguess = max;
  for (;;) {
    guess = f((min + max) / 2);
    less = 0;
    greater = 0;
    equal = 0;
    maxltguess = min;
    mingtguess = max;
    for (let i = 0; i < n; i++) {
      const x = m[i] ?? 0;
      if (x < guess) {
        less++;
        if (x > maxltguess) maxltguess = x;
      } else if (x > guess) {
        greater++;
        if (x < mingtguess) mingtguess = x;
      } else {
        equal++;
      }
    }
    const half = Math.trunc((n + 1) / 2);
    if (less <= half && greater <= half) break;
    else if (less > greater) max = maxltguess;
    else min = mingtguess;
  }
  const half = Math.trunc((n + 1) / 2);
  if (less >= half) return maxltguess;
  if (less + equal >= half) return guess;
  return mingtguess;
}

/** Each bit says whether its frequency component is above the median component. */
export function pdqBuffer16x16ToBits(dct16x16: Float32Array): Hash256 {
  const median = torben(dct16x16, 256);
  const h = newHash256();
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      if ((dct16x16[i * 16 + j] ?? 0) > median) setBit(h, i * 16 + j);
    }
  }
  return h;
}

/** `pdqHash256FromFloatLuma`. */
export function pdqHash256FromFloatLuma(
  fullBuffer1: Float32Array,
  fullBuffer2: Float32Array,
  numRows: number,
  numCols: number,
): { hash: Hash256; quality: number } {
  if (numRows < MIN_HASHABLE_DIM || numCols < MIN_HASHABLE_DIM) return { hash: newHash256(), quality: 0 };
  const { dct16x16, quality } = pdqFloat256FromFloatLuma(fullBuffer1, fullBuffer2, numRows, numCols);
  return { hash: pdqBuffer16x16ToBits(dct16x16), quality };
}

/** The eight dihedral transforms, computed in the DCT domain (`dct16OriginalTo*`). */
export type Dihedral = "orig" | "rot90" | "rot180" | "rot270" | "flipx" | "flipy" | "flipp" | "flipm";

function transform(A: Float32Array, kind: Dihedral): Float32Array {
  const B = new Float32Array(256);
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      const a = A[i * 16 + j] ?? 0;
      switch (kind) {
        case "orig":
          B[i * 16 + j] = a;
          break;
        case "rot90":
          B[j * 16 + i] = j & 1 ? a : -a;
          break;
        case "rot180":
          B[i * 16 + j] = (i + j) & 1 ? -a : a;
          break;
        case "rot270":
          B[j * 16 + i] = i & 1 ? a : -a;
          break;
        case "flipx":
          B[i * 16 + j] = i & 1 ? a : -a;
          break;
        case "flipy":
          B[i * 16 + j] = j & 1 ? a : -a;
          break;
        case "flipp":
          B[j * 16 + i] = a;
          break;
        case "flipm":
          B[j * 16 + i] = (i + j) & 1 ? -a : a;
          break;
      }
    }
  }
  return B;
}

/** `pdqDihedralHash256esFromFloatLuma`: all eight hashes from one DCT. */
export function pdqDihedralHash256esFromFloatLuma(
  fullBuffer1: Float32Array,
  fullBuffer2: Float32Array,
  numRows: number,
  numCols: number,
): { hashes: Record<Dihedral, Hash256>; quality: number } {
  const kinds: Dihedral[] = ["orig", "rot90", "rot180", "rot270", "flipx", "flipy", "flipp", "flipm"];
  if (numRows < MIN_HASHABLE_DIM || numCols < MIN_HASHABLE_DIM) {
    return { hashes: Object.fromEntries(kinds.map((k) => [k, newHash256()])) as Record<Dihedral, Hash256>, quality: 0 };
  }
  const { dct16x16, quality } = pdqFloat256FromFloatLuma(fullBuffer1, fullBuffer2, numRows, numCols);
  const hashes = Object.fromEntries(kinds.map((k) => [k, pdqBuffer16x16ToBits(transform(dct16x16, k))]));
  return { hashes: hashes as Record<Dihedral, Hash256>, quality };
}

/** Luma buffers for the reference entry points. */
export function floatLumaFromGrey(grey: Uint8Array, numRows: number, numCols: number): Float32Array {
  const luma = new Float32Array(numRows * numCols);
  fillFloatLumaFromGrey(grey, numRows, numCols, luma);
  return luma;
}

export function floatLumaFromRGB(rgb: Uint8Array, numRows: number, numCols: number): Float32Array {
  const luma = new Float32Array(numRows * numCols);
  fillFloatLumaFromRGB(rgb, numRows, numCols, luma);
  return luma;
}
