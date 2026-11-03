// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { decodePng } from "../../src/png.ts";
import {
  ART_SIZES,
  type ArtFormat,
  MIN_SHAPE_SHARE,
  artPng,
  artRng,
  artScene,
  artSvg,
  hslToRgb,
  rasterize,
} from "../../src/seed/art.ts";
import { createRng } from "../../src/seed/prng.ts";

const FORMATS = Object.keys(ART_SIZES) as ArtFormat[];
const root = () => createRng(1).fork("social").fork("identity-art");
const svgFor = (salt: string, format: ArtFormat, parent = root()) => artSvg(artScene(artRng(parent, salt), format));
const SALTS = Array.from({ length: 60 }, (_, i) => `0190f5d2-0000-7000-8000-${String(i).padStart(12, "0")}`);

/** Tags balance and every element is one the generator may write: a small well-formedness check. */
function wellFormed(svg: string): boolean {
  const allowed = new Set(["svg", "desc", "defs", "linearGradient", "stop", "rect", "circle", "polygon"]);
  const stack: string[] = [];
  const text = svg.replace(/<desc>[^<]*<\/desc>/g, "<desc/>");
  for (const m of text.matchAll(/<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g)) {
    const [, close, name = "", , self] = m;
    if (!allowed.has(name)) return false;
    if (close) {
      if (stack.pop() !== name) return false;
    } else if (!self) stack.push(name);
  }
  return stack.length === 0 && text.startsWith("<svg ") && text.endsWith("</svg>");
}

describe("the art generator", () => {
  test("the same salt gives byte-identical SVG and PNG; a resume (a fresh stream) draws the same", () => {
    for (const f of FORMATS) {
      expect(svgFor(SALTS[0] as string, f)).toBe(svgFor(SALTS[0] as string, f));
      const a = artPng(artScene(artRng(root(), "x"), f));
      const b = artPng(artScene(artRng(root(), "x"), f));
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    }
  });

  test("different salts give different art, and order of drawing does not matter", () => {
    const svgs = SALTS.map((s) => svgFor(s, "avatar"));
    expect(new Set(svgs).size).toBe(svgs.length);
    const parent = root();
    const later = svgFor(SALTS[5] as string, "avatar", parent);
    svgFor(SALTS[1] as string, "avatar", parent);
    expect(svgFor(SALTS[5] as string, "avatar", parent)).toBe(later);
    expect(svgFor("a", "avatar", createRng(2).fork("social"))).not.toBe(
      svgFor("a", "avatar", createRng(1).fork("social")),
    );
  });

  test("valid, small, script-free SVG in every format", () => {
    for (const f of FORMATS)
      for (const salt of SALTS) {
        const svg = svgFor(salt, f);
        expect(new TextEncoder().encode(svg).byteLength, `${f} ${salt}`).toBeLessThan(8 * 1024);
        expect(svg.toLowerCase()).not.toContain("<script");
        expect(svg.toLowerCase()).not.toContain("foreignobject");
        expect(svg).not.toMatch(/href/i);
        expect(svg).not.toMatch(/\son[a-z]+=/i);
        // The namespace is the only URL in it.
        expect(svg.match(/https?:\/\/[^"]+/g)).toEqual(["http://www.w3.org/2000/svg"]);
        expect(wellFormed(svg), svg).toBe(true);
        const { width, height } = ART_SIZES[f];
        expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
      }
  });

  test("formats: square avatars, 6:1 banners, 3:4 box art", () => {
    expect(ART_SIZES.avatar.width).toBe(ART_SIZES.avatar.height);
    expect(ART_SIZES.banner.width / ART_SIZES.banner.height).toBe(6);
    expect(ART_SIZES.boxArt.width / ART_SIZES.boxArt.height).toBeCloseTo(3 / 4, 2);
  });

  test("abstract only: large shapes, so nothing small enough to read as eyes", () => {
    for (const f of FORMATS)
      for (const salt of SALTS) {
        const scene = artScene(artRng(root(), salt), f);
        const short = Math.min(scene.width, scene.height);
        expect(scene.shapes.length).toBeGreaterThanOrEqual(3);
        const extent = (s: (typeof scene.shapes)[number]) => {
          if (s.kind !== "polygon") return 2 * s.r;
          const xs = s.points.map((p) => p[0]);
          const ys = s.points.map((p) => p[1]);
          return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        };
        for (const s of scene.shapes) expect(extent(s)).toBeGreaterThanOrEqual(short * MIN_SHAPE_SHARE);
      }
  });

  test("the PNG is the scene at the format's size, opaque, and decodes", () => {
    for (const f of FORMATS) {
      const scene = artScene(artRng(root(), "png"), f);
      const png = decodePng(artPng(scene));
      expect([png.width, png.height]).toEqual([ART_SIZES[f].width, ART_SIZES[f].height]);
      for (let i = 3; i < png.data.length; i += 4 * 97) expect(png.data[i]).toBe(255);
      expect(png.data).toEqual(rasterize(scene).data);
    }
  });

  test("the raster draws what the SVG says: a pixel inside an opaque-enough circle takes its colour", () => {
    const scene = {
      format: "avatar" as const,
      width: 8,
      height: 8,
      gradient: {
        x1: 0,
        y1: 0,
        x2: 8,
        y2: 0,
        stops: [
          { offset: 0, color: [0, 0, 0] as const },
          { offset: 1, color: [0, 0, 0] as const },
        ],
      },
      shapes: [{ kind: "circle" as const, cx: 4, cy: 4, r: 3, color: [200, 100, 50] as const, opacity: 1 }],
    };
    const { data } = rasterize(scene);
    const at = (x: number, y: number) => [...data.subarray((y * 8 + x) * 4, (y * 8 + x) * 4 + 3)];
    expect(at(4, 4)).toEqual([200, 100, 50]);
    expect(at(0, 0)).toEqual([0, 0, 0]);
    expect(artSvg(scene)).toContain('<circle cx="4" cy="4" r="3" fill="#c86432" fill-opacity="1"/>');
  });

  test("hslToRgb: primaries and greys", () => {
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 100, 50)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 100, 50)).toEqual([0, 0, 255]);
    expect(hslToRgb(0, 0, 50)).toEqual([128, 128, 128]);
  });
});
