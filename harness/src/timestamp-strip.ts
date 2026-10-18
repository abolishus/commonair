// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Machine-readable capture timestamp burned into every frame by simulated streamers.
 *
 * A strip of equal-width cells along the top-left edge of the frame:
 *
 *   [white][black] 44 data cells (epoch ms, MSB first) 8 check cells (ms mod 251, MSB first)
 *
 * White = 1, black = 0. The two sync cells give the decoder per-frame black/white reference
 * levels, so the threshold survives encoder gamma shifts and scaling. The checksum rejects frames
 * whose strip is mid-transition or smeared by compression. 44 bits of milliseconds cover dates up
 * to the year 2527. The encoder (`geqExpression`, run by ffmpeg) and the decoder (`decodeStrip`,
 * used by Node tests on PNG/raw frames and bundled into the player page) live in this one module so
 * the layout cannot drift.
 */

export const SYNC_CELLS = 2;
export const DATA_BITS = 44;
export const CHECK_BITS = 8;
export const CHECK_MODULUS = 251;
export const CELLS = SYNC_CELLS + DATA_BITS + CHECK_BITS;

export interface StripGeometry {
  /** Width of one cell in pixels (fractional: cells divide the full frame width). */
  cellWidth: number;
  /** Height of the strip in pixels. */
  height: number;
}

/** Smallest frame width a streamer may publish: 4 px cells survive 4:2:0 H.264 at low bitrates. */
export const MIN_FRAME_WIDTH = CELLS * 4;

/** Fraction of the frame height the strip occupies. */
export const STRIP_HEIGHT_FRACTION = 1 / 14;

/**
 * Strip geometry for a frame size. Both dimensions are proportional to the frame, so the strip
 * decodes the same way from any rendition or any canvas scale of the original frame.
 */
export function stripGeometry(frameWidth: number, frameHeight: number): StripGeometry {
  return { cellWidth: frameWidth / CELLS, height: stripHeight(frameHeight) };
}

/** Strip height in pixels for a frame height; even, so 4:2:0 chroma rows align with the strip edge. */
export function stripHeight(frameHeight: number): number {
  return Math.max(8, Math.round((frameHeight * STRIP_HEIGHT_FRACTION) / 2) * 2);
}

/** The bit pattern for a timestamp: one 0/1 per cell, sync cells included. */
export function encodeBits(epochMs: number): number[] {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs >= 2 ** DATA_BITS) {
    throw new RangeError("timestamp must be a non-negative integer below 2^44 ms");
  }
  const bits = [1, 0];
  for (let i = DATA_BITS - 1; i >= 0; i--) bits.push(Math.floor(epochMs / 2 ** i) % 2);
  const check = epochMs % CHECK_MODULUS;
  for (let i = CHECK_BITS - 1; i >= 0; i--) bits.push(Math.floor(check / 2 ** i) % 2);
  return bits;
}

/** Inverse of `encodeBits`; null when the sync cells or the checksum do not match. */
export function decodeBits(bits: readonly number[]): number | null {
  if (bits.length !== CELLS || bits[0] !== 1 || bits[1] !== 0) return null;
  let value = 0;
  for (let i = 0; i < DATA_BITS; i++) value = value * 2 + (bits[SYNC_CELLS + i] ?? 0);
  let check = 0;
  for (let i = 0; i < CHECK_BITS; i++) check = check * 2 + (bits[SYNC_CELLS + DATA_BITS + i] ?? 0);
  return value % CHECK_MODULUS === check ? value : null;
}

/**
 * ffmpeg `geq` luma expression drawing the strip for frame time `T` (seconds) plus `startEpochMs`,
 * applied to a full-width crop of the frame (so `W` is the frame width).
 * Variables: st(0) = cell index, st(1) = timestamp in ms. The result is quoted for a filtergraph.
 */
export function geqExpression(startEpochMs: number): string {
  if (!Number.isSafeInteger(startEpochMs) || startEpochMs < 0)
    throw new RangeError("start must be a non-negative integer");
  const dataEnd = SYNC_CELLS + DATA_BITS;
  const lastData = dataEnd - 1;
  const lastCheck = CELLS - 1;
  const expr = [
    `st(0,floor(X*${CELLS}/W))`,
    `st(1,${startEpochMs}+round(T*1000))`,
    `if(lt(ld(0),1),255,if(lt(ld(0),2),0,if(lt(ld(0),${dataEnd}),` +
      `255*mod(floor(ld(1)/pow(2,${lastData}-ld(0))),2),` +
      `255*mod(floor(mod(ld(1),${CHECK_MODULUS})/pow(2,${lastCheck}-ld(0))),2))))`,
  ].join(";");
  return `'${expr}'`;
}

/** A grayscale or RGBA pixel source the decoder can sample. */
export interface PixelSource {
  width: number;
  height: number;
  /** Luma (0–255) at integer pixel coordinates. */
  luma(x: number, y: number): number;
}

/** Wrap RGBA bytes (canvas ImageData, decoded PNG) as a PixelSource. */
export function rgbaSource(data: ArrayLike<number>, width: number, height: number): PixelSource {
  return {
    width,
    height,
    luma(x, y) {
      const i = (y * width + x) * 4;
      // BT.601 luma; exact weights do not matter much because thresholds come from the sync cells.
      return 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
    },
  };
}

/** Wrap 8-bit grayscale bytes (ffmpeg `-pix_fmt gray` rawvideo) as a PixelSource. */
export function graySource(data: ArrayLike<number>, width: number, height: number): PixelSource {
  return { width, height, luma: (x, y) => data[y * width + x] ?? 0 };
}

/** Decode the strip from a frame of any scale; null when no valid strip is present. */
export function decodeStrip(src: PixelSource, geometry = stripGeometry(src.width, src.height)): number | null {
  const sampleCell = (cell: number): number => {
    // Average the central half of the cell to ignore ringing at the edges.
    const x0 = Math.floor(cell * geometry.cellWidth + geometry.cellWidth / 4);
    const x1 = Math.max(x0, Math.ceil(cell * geometry.cellWidth + (geometry.cellWidth * 3) / 4) - 1);
    const y0 = Math.floor(geometry.height / 4);
    const y1 = Math.max(y0, Math.ceil((geometry.height * 3) / 4) - 1);
    let sum = 0;
    let n = 0;
    for (let y = y0; y <= Math.min(y1, src.height - 1); y++) {
      for (let x = x0; x <= Math.min(x1, src.width - 1); x++) {
        sum += src.luma(x, y);
        n++;
      }
    }
    return n === 0 ? 0 : sum / n;
  };
  const white = sampleCell(0);
  const black = sampleCell(1);
  // Low contrast means this is not our strip (e.g. a black frame before the first keyframe).
  if (white - black < 64) return null;
  const threshold = (white + black) / 2;
  const bits: number[] = [];
  for (let c = 0; c < CELLS; c++) bits.push(sampleCell(c) >= threshold ? 1 : 0);
  return decodeBits(bits);
}
