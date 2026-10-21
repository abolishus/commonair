// SPDX-FileCopyrightText: Meta Platforms, Inc. and affiliates.
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Port of ThreatExchange `pdq/cpp/downscaling/downscaling.cpp` at tag hma-v1.1.7.
 *
 * The reference computes in 32-bit `float`. Buffers here are `Float32Array` and every
 * intermediate result goes through `Math.fround`, so each operation rounds exactly as a C++
 * float operation does (a double result of +, -, *, / on two floats rounded once to float is the
 * correctly rounded float result). Integer index arithmetic is done in doubles, as in the C++.
 */

const f = Math.fround;

// Standard RGB to luminance (the 'Y' in 'YUV'), as float constants.
const LUMA_FROM_R = f(0.299);
const LUMA_FROM_G = f(0.587);
const LUMA_FROM_B = f(0.114);

/** `fillFloatLumaFromRGB` on packed RGB (3 bytes per pixel, row-major). */
export function fillFloatLumaFromRGB(rgb: Uint8Array, numRows: number, numCols: number, luma: Float32Array): void {
  const n = numRows * numCols;
  for (let k = 0, p = 0; k < n; k++, p += 3) {
    luma[k] = f(
      f(f(LUMA_FROM_R * (rgb[p] ?? 0)) + f(LUMA_FROM_G * (rgb[p + 1] ?? 0))) + f(LUMA_FROM_B * (rgb[p + 2] ?? 0)),
    );
  }
}

/** `fillFloatLumaFromGrey` on packed 8-bit grey (row-major). */
export function fillFloatLumaFromGrey(grey: Uint8Array, numRows: number, numCols: number, luma: Float32Array): void {
  const n = numRows * numCols;
  for (let k = 0; k < n; k++) luma[k] = grey[k] ?? 0;
}

/** Nearest sampling at target centers, not corners. */
export function decimateFloat(
  input: Float32Array,
  inNumRows: number,
  inNumCols: number,
  out: Float32Array,
  outNumRows: number,
  outNumCols: number,
): void {
  for (let outi = 0; outi < outNumRows; outi++) {
    const ini = Math.trunc(((outi + 0.5) * inNumRows) / outNumRows);
    for (let outj = 0; outj < outNumCols; outj++) {
      const inj = Math.trunc(((outj + 0.5) * inNumCols) / outNumCols);
      out[outi * outNumCols + outj] = input[ini * inNumCols + inj] ?? 0;
    }
  }
}

/** Round up: two passes, so half of 1/(new dimension) of the old dimension per pass. */
export function computeJaroszFilterWindowSize(oldDimension: number, newDimension: number): number {
  return Math.trunc((oldDimension + 2 * newDimension - 1) / (2 * newDimension));
}

/** Repeated X then Y box filters (a tent filter after two passes). Result is in `buffer1`. */
export function jaroszFilterFloat(
  buffer1: Float32Array,
  buffer2: Float32Array,
  numRows: number,
  numCols: number,
  windowSizeAlongRows: number,
  windowSizeAlongCols: number,
  nreps: number,
): void {
  for (let i = 0; i < nreps; i++) {
    boxAlongRowsFloat(buffer1, buffer2, numRows, numCols, windowSizeAlongRows);
    boxAlongColsFloat(buffer2, buffer1, numRows, numCols, windowSizeAlongCols);
  }
}

/**
 * One-dimensional box filter with a running sum, in the reference's four phases (accumulate,
 * growing window, full window, shrinking window). `offset` and `stride` address a row or column.
 */
export function box1DFloat(
  invec: Float32Array,
  outvec: Float32Array,
  offset: number,
  vectorLength: number,
  stride: number,
  fullWindowSize: number,
): void {
  const halfWindowSize = Math.trunc((fullWindowSize + 2) / 2); // 7->4, 8->5

  const phase1Nreps = halfWindowSize - 1;
  const phase2Nreps = fullWindowSize - halfWindowSize + 1;
  const phase3Nreps = vectorLength - fullWindowSize;
  const phase4Nreps = halfWindowSize - 1;

  let li = offset; // left edge of the read window, for subtracts
  let ri = offset; // right edge of the read window, for adds
  let oi = offset; // output index

  let sum = 0;
  let currentWindowSize = 0;

  for (let i = 0; i < phase1Nreps; i++) {
    sum = f(sum + (invec[ri] ?? 0));
    currentWindowSize++;
    ri += stride;
  }
  for (let i = 0; i < phase2Nreps; i++) {
    sum = f(sum + (invec[ri] ?? 0));
    currentWindowSize++;
    outvec[oi] = f(sum / currentWindowSize);
    ri += stride;
    oi += stride;
  }
  for (let i = 0; i < phase3Nreps; i++) {
    sum = f(sum + (invec[ri] ?? 0));
    sum = f(sum - (invec[li] ?? 0));
    outvec[oi] = f(sum / currentWindowSize);
    li += stride;
    ri += stride;
    oi += stride;
  }
  for (let i = 0; i < phase4Nreps; i++) {
    sum = f(sum - (invec[li] ?? 0));
    currentWindowSize--;
    outvec[oi] = f(sum / currentWindowSize);
    li += stride;
    oi += stride;
  }
}

export function boxAlongRowsFloat(
  input: Float32Array,
  out: Float32Array,
  numRows: number,
  numCols: number,
  windowSize: number,
): void {
  for (let i = 0; i < numRows; i++) box1DFloat(input, out, i * numCols, numCols, 1, windowSize);
}

export function boxAlongColsFloat(
  input: Float32Array,
  out: Float32Array,
  numRows: number,
  numCols: number,
  windowSize: number,
): void {
  for (let j = 0; j < numCols; j++) box1DFloat(input, out, j, numRows, numCols, windowSize);
}
