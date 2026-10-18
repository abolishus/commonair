// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { videoFilter } from "../src/ffmpeg.ts";
import { decodePng } from "../src/png.ts";
import {
  CELLS,
  DATA_BITS,
  decodeBits,
  decodeStrip,
  encodeBits,
  graySource,
  rgbaSource,
  stripGeometry,
  stripHeight,
} from "../src/timestamp-strip.ts";

/** Paint the strip for `ms` into a gray frame exactly as the geq expression does. */
function paint(ms: number, width: number, height: number): Uint8Array {
  const frame = new Uint8Array(width * height).fill(90);
  const bits = encodeBits(ms);
  const h = stripHeight(height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) frame[y * width + x] = bits[Math.floor((x * CELLS) / width)] ? 255 : 0;
  }
  return frame;
}

describe("bit layout", () => {
  test.each([0, 1, 1_760_000_000_123, 2 ** DATA_BITS - 1, 4_102_444_800_000])("round-trips %d", (ms) => {
    const bits = encodeBits(ms);
    expect(bits).toHaveLength(CELLS);
    expect(bits.slice(0, 2)).toEqual([1, 0]);
    expect(decodeBits(bits)).toBe(ms);
  });

  test("rejects out-of-range timestamps", () => {
    expect(() => encodeBits(-1)).toThrow(RangeError);
    expect(() => encodeBits(2 ** DATA_BITS)).toThrow(RangeError);
    expect(() => encodeBits(1.5)).toThrow(RangeError);
  });

  test("any single flipped data bit fails the checksum or the sync check", () => {
    const ms = 1_760_000_000_123;
    const bits = encodeBits(ms);
    for (let i = 0; i < CELLS; i++) {
      const flipped = [...bits];
      flipped[i] = flipped[i] === 1 ? 0 : 1;
      expect(decodeBits(flipped)).not.toBe(ms);
    }
  });

  test("wrong length or broken sync decodes to null", () => {
    expect(decodeBits([1, 0, 1])).toBeNull();
    const bits = encodeBits(42);
    bits[0] = 0;
    expect(decodeBits(bits)).toBeNull();
  });
});

describe("pixel decoding", () => {
  test("decodes a painted frame at source scale", () => {
    const ms = 1_760_000_123_456;
    expect(decodeStrip(graySource(paint(ms, 1280, 720), 1280, 720))).toBe(ms);
  });

  test("decodes when the frame is downscaled (geometry is proportional)", () => {
    const ms = 1_760_000_999_001;
    const src = paint(ms, 1280, 720);
    // Nearest-neighbour downscale to 320×180, like a small canvas.
    const w = 320;
    const h = 180;
    const small = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) small[y * w + x] = src[y * 4 * 1280 + x * 4] ?? 0;
    expect(decodeStrip(graySource(small, w, h))).toBe(ms);
  });

  test("a frame without a strip decodes to null", () => {
    expect(decodeStrip(graySource(new Uint8Array(640 * 360).fill(128), 640, 360))).toBeNull();
  });

  test("RGBA sources use luma", () => {
    const ms = 123_456_789;
    const gray = paint(ms, 640, 360);
    const rgba = new Uint8Array(640 * 360 * 4);
    for (let i = 0; i < gray.length; i++) rgba.set([gray[i] ?? 0, gray[i] ?? 0, gray[i] ?? 0, 255], i * 4);
    expect(decodeStrip(rgbaSource(rgba, 640, 360))).toBe(ms);
  });

  test("geometry scales with the frame", () => {
    expect(stripGeometry(1080, 1080).cellWidth).toBeCloseTo(1080 / CELLS);
    expect(stripHeight(720)).toBe(52);
    expect(stripHeight(90)).toBe(8);
    expect(stripHeight(720) % 2).toBe(0);
  });
});

describe("ffmpeg render → PNG → decode", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-strip-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function renderFrame(opts: {
    width: number;
    height: number;
    fps: number;
    at: number;
    start: number;
    encode?: boolean;
    pixFmt?: string;
  }) {
    const png = join(dir, `f-${opts.width}-${opts.at}-${opts.pixFmt ?? "rgb24"}${opts.encode ? "-h264" : ""}.png`);
    const graph = videoFilter({ width: opts.width, height: opts.height, startEpochMs: opts.start, timecode: false });
    const source = ["-f", "lavfi", "-i", `testsrc2=size=${opts.width}x${opts.height}:rate=${opts.fps}`];
    let cmd: string[];
    if (opts.encode) {
      // Through a real low-bitrate H.264 encode, like the stream viewers decode.
      const mp4 = png.replace(/\.png$/, ".mp4");
      const enc = Bun.spawn(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          ...source,
          "-filter_complex",
          graph,
          "-map",
          "[v]",
          "-t",
          String(opts.at + 0.5),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-b:v",
          "300k",
          "-pix_fmt",
          "yuv420p",
          mp4,
        ],
        { stderr: "pipe" },
      );
      if ((await enc.exited) !== 0) throw new Error(await new Response(enc.stderr).text());
      cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(opts.at),
        "-i",
        mp4,
        "-frames:v",
        "1",
        "-pix_fmt",
        opts.pixFmt ?? "rgb24",
        png,
      ];
    } else {
      cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        ...source,
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-ss",
        String(opts.at),
        "-frames:v",
        "1",
        "-pix_fmt",
        opts.pixFmt ?? "rgb24",
        png,
      ];
    }
    const proc = Bun.spawn(cmd, { stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(await new Response(proc.stderr).text());
    return decodePng(new Uint8Array(readFileSync(png)));
  }

  test("a raw rendered frame decodes to start + frame time", async () => {
    const start = 1_760_000_000_000;
    const img = await renderFrame({ width: 640, height: 360, fps: 30, at: 2, start });
    const decoded = decodeStrip(rgbaSource(img.data, img.width, img.height));
    expect(decoded).not.toBeNull();
    // ±1 frame at 30 fps.
    expect(Math.abs((decoded ?? 0) - (start + 2000))).toBeLessThanOrEqual(34);
  }, 30_000);

  test.each(["gray", "rgba", "rgb24"])(
    "decodes after an H.264 encode (%s PNG)",
    async (pixFmt) => {
      const start = 1_770_000_000_555;
      const img = await renderFrame({ width: 640, height: 360, fps: 25, at: 1.2, start, encode: true, pixFmt });
      const decoded = decodeStrip(rgbaSource(img.data, img.width, img.height));
      expect(Math.abs((decoded ?? 0) - (start + 1200))).toBeLessThanOrEqual(41);
    },
    30_000,
  );
});
