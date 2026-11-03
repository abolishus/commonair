// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The seed's generated art (decision (d) of `.claude/briefs/d/README.md`): abstract compositions of
 * a linear gradient and a few large circles, rings and polygons, drawn from a seeded PRNG. Never a
 * photo, a face, text or anything that could pass for a person or a brand, and never fetched. The
 * images it makes are dedicated to the public domain (CC0-1.0); this code is AGPL like the rest.
 *
 * One scene renders two ways: `artSvg` (the canonical form, small and script-free) and `artPng`, a
 * rasterization of the same scene. The upload endpoint takes PNG, JPEG, WebP or GIF but not SVG
 * (`UPLOAD_TYPES`), and the harness has a PNG encoder and no WebP one, so the seed uploads PNG.
 * Pure: the same PRNG stream gives byte-identical output.
 */
import { encodePng } from "../png.ts";
import type { Rng } from "./prng.ts";

export type ArtFormat = "avatar" | "banner" | "boxArt" | "panel";

/** Pixel sizes: square avatars, 6:1 banners (the dashboard's banner ratio), 3:4 box art, 2:1 panels. */
export const ART_SIZES: Record<ArtFormat, { width: number; height: number }> = {
  avatar: { width: 256, height: 256 },
  banner: { width: 1200, height: 200 },
  boxArt: { width: 285, height: 380 },
  panel: { width: 320, height: 160 },
};

const SHAPE_COUNTS: Record<ArtFormat, readonly [number, number]> = {
  avatar: [3, 5],
  banner: [5, 8],
  boxArt: [4, 6],
  panel: [3, 5],
};

/**
 * Smallest shape, as a share of the image's shorter side. Large shapes only: small round marks in
 * pairs are what reads as eyes, and the art must never suggest a face.
 */
export const MIN_SHAPE_SHARE = 0.2;

export type Rgb = readonly [number, number, number];

export interface GradientStop {
  offset: number;
  color: Rgb;
}

export type ArtShape =
  | { kind: "circle"; cx: number; cy: number; r: number; color: Rgb; opacity: number }
  | { kind: "ring"; cx: number; cy: number; r: number; width: number; color: Rgb; opacity: number }
  | { kind: "polygon"; points: readonly (readonly [number, number])[]; color: Rgb; opacity: number };

export interface ArtScene {
  format: ArtFormat;
  width: number;
  height: number;
  /** In pixel coordinates (`userSpaceOnUse`); clamped beyond its ends, as SVG's default `pad`. */
  gradient: { x1: number; y1: number; x2: number; y2: number; stops: readonly GradientStop[] };
  shapes: readonly ArtShape[];
}

/** The PRNG stream for one piece: `salt` is the user id (or the category slug), so a resume redraws the same art. */
export const artRng = (parent: Rng, salt: string): Rng => parent.fork(`art:${salt}`);

/** One decimal place: the SVG prints these values and the rasterizer draws exactly them. */
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** HSL (degrees, percent, percent) to 8-bit sRGB. Pure. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** A palette of related hues: analogous, complementary or triadic around a random base. */
function palette(rng: Rng): Rgb[] {
  const base = rng.int(0, 359);
  const offsets = rng.pick([
    [0, 25, 50, 335],
    [0, 180, 30, 210],
    [0, 120, 240, 60],
  ]);
  return offsets.map((o) => hslToRgb((base + o) % 360, rng.int(45, 80), rng.int(35, 65)));
}

/** A scene for `format` from `rng` (use `artRng`). Pure given the stream. */
export function artScene(rng: Rng, format: ArtFormat): ArtScene {
  const { width, height } = ART_SIZES[format];
  const short = Math.min(width, height);
  const colors = palette(rng);
  const pick = () => rng.pick(colors);
  // The gradient runs corner to corner in one of eight directions.
  const angle = (rng.int(0, 7) * Math.PI) / 4;
  const cx = width / 2;
  const cy = height / 2;
  const reach = Math.hypot(width, height) / 2;
  const dx = Math.cos(angle) * reach;
  const dy = Math.sin(angle) * reach;
  const [first, second] = rng.sample(colors, 2);
  const stops: GradientStop[] = [
    { offset: 0, color: first ?? colors[0] ?? [0, 0, 0] },
    ...(rng.chance(0.5) ? [{ offset: r2(rng.int(35, 65) / 100), color: pick() }] : []),
    { offset: 1, color: second ?? colors[1] ?? [255, 255, 255] },
  ];
  const [lo, hi] = SHAPE_COUNTS[format];
  const n = rng.int(lo, hi);
  const shapes: ArtShape[] = [];
  const minR = short * MIN_SHAPE_SHARE;
  const maxR = short * 0.7;
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(["circle", "circle", "ring", "polygon", "polygon"] as const);
    const x = r1(rng.next() * width);
    const y = r1(rng.next() * height);
    const radius = r1(minR + rng.next() * (maxR - minR));
    const opacity = r2(0.35 + rng.next() * 0.5);
    if (kind === "circle") shapes.push({ kind, cx: x, cy: y, r: radius, color: pick(), opacity });
    else if (kind === "ring")
      shapes.push({
        kind,
        cx: x,
        cy: y,
        r: radius,
        width: r1(short * (0.04 + rng.next() * 0.08)),
        color: pick(),
        opacity,
      });
    else {
      const sides = rng.int(3, 4);
      const turn = rng.next() * Math.PI * 2;
      const points = Array.from({ length: sides }, (_, k) => {
        const a = turn + (k * Math.PI * 2) / sides + (rng.next() - 0.5) * 0.6;
        return [r1(x + Math.cos(a) * radius), r1(y + Math.sin(a) * radius)] as const;
      });
      shapes.push({ kind, points, color: pick(), opacity });
    }
  }
  return {
    format,
    width,
    height,
    gradient: { x1: r1(cx - dx), y1: r1(cy - dy), x2: r1(cx + dx), y2: r1(cy + dy), stops },
    shapes,
  };
}

/** The scene as a standalone SVG document: no script, no foreignObject, no href of any kind. Pure. */
export function artSvg(scene: ArtScene): string {
  const g = scene.gradient;
  const stops = g.stops.map((s) => `<stop offset="${s.offset}" stop-color="${hex(s.color)}"/>`).join("");
  const shapes = scene.shapes.map((s) => {
    if (s.kind === "circle")
      return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="${hex(s.color)}" fill-opacity="${s.opacity}"/>`;
    if (s.kind === "ring")
      return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" fill="none" stroke="${hex(s.color)}" stroke-width="${s.width}" stroke-opacity="${s.opacity}"/>`;
    const pts = s.points.map(([x, y]) => `${x},${y}`).join(" ");
    return `<polygon points="${pts}" fill="${hex(s.color)}" fill-opacity="${s.opacity}"/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`,
    "<desc>Generated abstract art, CC0-1.0</desc>",
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}">${stops}</linearGradient></defs>`,
    `<rect width="${scene.width}" height="${scene.height}" fill="url(#g)"/>`,
    ...shapes,
    "</svg>",
  ].join("");
}

function gradientAt(g: ArtScene["gradient"], x: number, y: number, out: number[]): void {
  const vx = g.x2 - g.x1;
  const vy = g.y2 - g.y1;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - g.x1) * vx + (y - g.y1) * vy) / len));
  const stops = g.stops;
  let i = 0;
  while (i < stops.length - 2 && t > (stops[i + 1]?.offset ?? 1)) i++;
  const a = stops[i];
  const b = stops[i + 1] ?? a;
  if (!a || !b) return;
  const span = b.offset - a.offset;
  const u = span <= 0 ? 0 : Math.max(0, Math.min(1, (t - a.offset) / span));
  for (let c = 0; c < 3; c++) out[c] = (a.color[c] ?? 0) + ((b.color[c] ?? 0) - (a.color[c] ?? 0)) * u;
}

function inside(s: ArtShape, x: number, y: number): boolean {
  if (s.kind === "circle") return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  if (s.kind === "ring") return Math.abs(Math.hypot(x - s.cx, y - s.cy) - s.r) <= s.width / 2;
  // Even-odd crossing test (SVG's default nonzero rule agrees for these simple polygons).
  let hit = false;
  const p = s.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i] ?? [0, 0];
    const [xj, yj] = p[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function bounds(s: ArtShape): [number, number, number, number] {
  if (s.kind === "polygon") {
    const xs = s.points.map((q) => q[0]);
    const ys = s.points.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  const e = s.r + (s.kind === "ring" ? s.width / 2 : 0);
  return [s.cx - e, s.cy - e, s.cx + e, s.cy + e];
}

/** Samples per pixel side (4 per pixel): enough antialiasing for large shapes. */
const SUPERSAMPLE = 2;

/** The scene as 8-bit RGBA pixels, drawn as the SVG draws it (source-over, sRGB). Pure. */
export function rasterize(scene: ArtScene): { width: number; height: number; data: Uint8Array } {
  const { width, height } = scene;
  const data = new Uint8Array(width * height * 4);
  const boxes = scene.shapes.map(bounds);
  const px = [0, 0, 0];
  const sum = [0, 0, 0];
  const step = 1 / SUPERSAMPLE;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      sum[0] = sum[1] = sum[2] = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++)
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const fx = x + (sx + 0.5) * step;
          const fy = y + (sy + 0.5) * step;
          gradientAt(scene.gradient, fx, fy, px);
          for (let i = 0; i < scene.shapes.length; i++) {
            const s = scene.shapes[i];
            const b = boxes[i];
            if (!s || !b || fx < b[0] || fx > b[2] || fy < b[1] || fy > b[3] || !inside(s, fx, fy)) continue;
            for (let c = 0; c < 3; c++) px[c] = (px[c] ?? 0) * (1 - s.opacity) + (s.color[c] ?? 0) * s.opacity;
          }
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (px[c] ?? 0);
        }
      const o = (y * width + x) * 4;
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      data[o] = Math.round((sum[0] ?? 0) / samples);
      data[o + 1] = Math.round((sum[1] ?? 0) / samples);
      data[o + 2] = Math.round((sum[2] ?? 0) / samples);
      data[o + 3] = 255;
    }
  return { width, height, data };
}

/** The scene as a PNG, for the upload endpoint. Pure. */
export const artPng = (scene: ArtScene): Uint8Array => encodePng(rasterize(scene));
