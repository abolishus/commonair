// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { inflateSync } from "node:zlib";
import { describe, expect, test } from "vite-plus/test";
import { decodePng, encodePng, testCardPng } from "../src/png.ts";

describe("encodePng", () => {
  test("round-trips through decodePng", () => {
    const data = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 0xff);
    const decoded = decodePng(encodePng({ width: 3, height: 2, data }));
    expect(decoded).toEqual({ width: 3, height: 2, data });
  });

  test("writes valid chunk CRCs (the IEND CRC is a fixed, well-known value)", () => {
    const png = encodePng({ width: 1, height: 1, data: new Uint8Array(4) });
    const tail = png.subarray(png.length - 12);
    expect([...tail]).toEqual([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    // IDAT holds one filter byte plus four RGBA bytes.
    const idat = png.subarray(33 + 8, png.length - 12 - 4);
    expect(inflateSync(idat).length).toBe(5);
  });

  test("refuses data of the wrong size", () => {
    expect(() => encodePng({ width: 2, height: 2, data: new Uint8Array(4) })).toThrow(/does not match/);
  });
});

describe("testCardPng", () => {
  test("is an opaque square PNG of the requested size", () => {
    const card = decodePng(testCardPng(64));
    expect([card.width, card.height]).toEqual([64, 64]);
    expect(card.data.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
  });
});
