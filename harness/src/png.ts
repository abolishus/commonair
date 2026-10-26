// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Minimal PNG decoder for frames ffmpeg writes and screenshots Playwright takes: 8-bit gray,
 * gray+alpha, RGB and RGBA, non-interlaced. Enough to read the timestamp strip without a
 * native image dependency. `encodePng` writes 8-bit RGBA, for images scenarios upload.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error("not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = body[8];
      colorType = body[9] ?? -1;
      const interlace = body[12];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
      if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
      if (!(colorType in CHANNELS)) throw new Error(`unsupported PNG color type ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) throw new Error("PNG is missing IHDR or IDAT");
  const channels = CHANNELS[colorType] ?? 4;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const pixels = unfilter(raw, width, height, channels);
  return { width, height, data: toRgba(pixels, width * height, channels) };
}

function unfilter(raw: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prev + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[prev + x - bpp] ?? 0) : 0;
      const v = line[x] ?? 0;
      let r: number;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`invalid PNG filter type ${filter}`);
      }
      out[row + x] = r & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function toRgba(pixels: Uint8Array, count: number, channels: number): Uint8Array {
  if (channels === 4) return pixels;
  const out = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1 || channels === 2) {
      const g = pixels[s] ?? 0;
      out[d] = g;
      out[d + 1] = g;
      out[d + 2] = g;
      out[d + 3] = channels === 2 ? (pixels[s + 1] ?? 255) : 255;
    } else {
      out[d] = pixels[s] ?? 0;
      out[d + 1] = pixels[s + 1] ?? 0;
      out[d + 2] = pixels[s + 2] ?? 0;
      out[d + 3] = 255;
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** 8-bit RGBA, non-interlaced, filter 0 on every row. */
export function encodePng({ width, height, data }: DecodedPng): Uint8Array {
  if (data.length !== width * height * 4) throw new Error("RGBA data does not match the size");
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** A harmless test card (hue bands over a vertical fade) for scenarios that upload an image. */
export function testCardPng(size = 128): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const bands = [
    [230, 60, 60],
    [240, 200, 40],
    [60, 180, 90],
    [50, 120, 230],
  ] as const;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const band = bands[Math.floor((x * bands.length) / size)] ?? bands[0];
      const fade = 0.4 + (0.6 * y) / size;
      const i = (y * size + x) * 4;
      data.set([band[0] * fade, band[1] * fade, band[2] * fade, 255], i);
    }
  return encodePng({ width: size, height: size, data });
}
