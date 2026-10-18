// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { chooseEncoder, HwaccelUnavailableError, parseEncoders } from "../src/ffmpeg/hwaccel.ts";

const ENCODERS_WITH_NVENC = `Encoders:
 V..... = Video
 A..... = Audio
 S..... = Subtitle
 .F.... = Frame-level multithreading
 ..S... = Slice-level multithreading
 ...X.. = Codec is experimental
 ....B. = Supports draw_horiz_band
 .....D = Supports direct rendering method 1
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D libwebp              libwebp WebP image (codec webp)
 A....D aac                  AAC (Advanced Audio Coding)
 A..X.D opus                 Opus
 S..... ass                  ASS (Advanced SubStation Alpha) subtitle
`;

const ENCODERS_CPU_ONLY = ENCODERS_WITH_NVENC.split("\n")
  .filter((l) => !/nvenc|libwebp/.test(l))
  .join("\n");

describe("parseEncoders", () => {
  test("reads encoder names from the table, not the legend", () => {
    const names = parseEncoders(ENCODERS_WITH_NVENC);
    expect(names.has("libx264")).toBe(true);
    expect(names.has("h264_nvenc")).toBe(true);
    expect(names.has("libwebp")).toBe(true);
    expect(names.has("opus")).toBe(true);
    expect(names.has("ass")).toBe(true);
    expect(names.has("=")).toBe(false);
    expect(names.size).toBe(6);
  });

  test("a build without NVENC", () => {
    const names = parseEncoders(ENCODERS_CPU_ONLY);
    expect(names.has("h264_nvenc")).toBe(false);
    expect(names.has("libx264")).toBe(true);
  });

  test("empty or garbage output yields nothing", () => {
    expect(parseEncoders("").size).toBe(0);
    expect(parseEncoders("ffmpeg: command not found").size).toBe(0);
  });
});

describe("chooseEncoder", () => {
  test("auto uses NVENC only when listed AND the test encode works", () => {
    expect(chooseEncoder("auto", { listed: true, testEncodeOk: true })).toBe("h264_nvenc");
    expect(chooseEncoder("auto", { listed: true, testEncodeOk: false })).toBe("libx264");
    expect(chooseEncoder("auto", { listed: false, testEncodeOk: null })).toBe("libx264");
  });

  test("nvenc forces the GPU and fails loudly when it is unusable", () => {
    expect(chooseEncoder("nvenc", { listed: true, testEncodeOk: true })).toBe("h264_nvenc");
    expect(() => chooseEncoder("nvenc", { listed: false, testEncodeOk: null })).toThrow(HwaccelUnavailableError);
    expect(() =>
      chooseEncoder("nvenc", { listed: true, testEncodeOk: false, testError: "No NVENC capable devices found" }),
    ).toThrow(/No NVENC capable devices/);
  });

  test("none always uses the CPU", () => {
    expect(chooseEncoder("none", { listed: true, testEncodeOk: true })).toBe("libx264");
  });
});
