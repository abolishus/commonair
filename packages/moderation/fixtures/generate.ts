/// <reference types="bun" />
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SYNTHETIC TEST PATTERNS ONLY. Draws deterministic geometric images (shapes, gradients,
 * checkerboards, seeded noise) as raw pixels, encodes them as PNG with ffmpeg, and writes the
 * fixture hash lists `csam.pdq` and `ncii.pdq` from their PDQ hashes. The patterns stand in for
 * list entries in tests and the `trust-safety` harness scenario; they depict nothing.
 *
 *   bun packages/moderation/fixtures/generate.ts
 *
 * The hashes are taken through the same path media uses (`decodeImage` → 512² luma → `pdqHash`).
 */
import process from "node:process";
import { decodeImage, encodeImage } from "../src/frames.ts";
import { pdqHash } from "../src/pdq.ts";

export const FIXTURE_WIDTH = 1280;
export const FIXTURE_HEIGHT = 720;

type Rgb = readonly [number, number, number];

class Canvas {
  readonly px: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    bg: Rgb,
  ) {
    this.px = new Uint8Array(w * h * 3);
    this.rect(0, 0, w, h, bg);
  }
  set(x: number, y: number, c: Rgb) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    this.px[o] = c[0];
    this.px[o + 1] = c[1];
    this.px[o + 2] = c[2];
  }
  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, c);
  }
  disc(cx: number, cy: number, r: number, c: Rgb) {
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, c);
  }
  ring(cx: number, cy: number, r0: number, r1: number, c: Rgb) {
    for (let y = cy - r1; y <= cy + r1; y++)
      for (let x = cx - r1; x <= cx + r1; x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d <= r1 * r1 && d >= r0 * r0) this.set(x, y, c);
      }
  }
  /** Filled triangle by edge functions. */
  triangle(a: [number, number], b: [number, number], c: [number, number], col: Rgb) {
    const minX = Math.min(a[0], b[0], c[0]);
    const maxX = Math.max(a[0], b[0], c[0]);
    const minY = Math.min(a[1], b[1], c[1]);
    const maxY = Math.max(a[1], b[1], c[1]);
    const edge = (p: [number, number], q: [number, number], x: number, y: number) =>
      (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const e0 = edge(a, b, x, y);
        const e1 = edge(b, c, x, y);
        const e2 = edge(c, a, x, y);
        if ((e0 >= 0 && e1 >= 0 && e2 >= 0) || (e0 <= 0 && e1 <= 0 && e2 <= 0)) this.set(x, y, col);
      }
  }
}

/** mulberry32: a tiny seeded PRNG, so "noise" is reproducible bit for bit. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = FIXTURE_WIDTH;
const H = FIXTURE_HEIGHT;
const BLACK: Rgb = [16, 16, 16];
const WHITE: Rgb = [240, 240, 240];

/** CSAM-list fixture: large asymmetric high-contrast blocks, a disc and a triangle. */
function t0Pattern(): Uint8Array {
  const c = new Canvas(W, H, BLACK);
  c.rect(0, 0, 560, 300, WHITE);
  c.rect(820, 420, W, H, [250, 220, 40]);
  c.disc(900, 190, 150, WHITE);
  c.triangle([80, 680], [480, 380], [560, 700], [40, 200, 250]);
  c.rect(600, 330, 760, H, WHITE);
  return c.px;
}

/** NCII-list fixture: a different composition (concentric rings and diagonal bands). */
function t0NciiPattern(): Uint8Array {
  const c = new Canvas(W, H, WHITE);
  for (let i = 0; i < 6; i++) c.triangle([i * 260 - 200, H], [i * 260, 0], [i * 260 + 110, 0], BLACK);
  c.ring(360, 360, 120, 240, [200, 30, 60]);
  c.disc(360, 360, 70, BLACK);
  c.rect(940, 80, 1220, 300, BLACK);
  return c.px;
}

/** Benign: a smooth two-axis gradient. */
function benignGradient(): Uint8Array {
  const c = new Canvas(W, H, BLACK);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) c.set(x, y, [Math.floor((255 * x) / W), Math.floor((255 * y) / H), 128]);
  return c.px;
}

/** Benign: an 8×4 checkerboard. */
function benignCheckerboard(): Uint8Array {
  const c = new Canvas(W, H, WHITE);
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 8; i++) if ((i + j) % 2 === 0) c.rect(i * 160, j * 180, (i + 1) * 160, (j + 1) * 180, BLACK);
  return c.px;
}

/** Benign: seeded blocky noise (40 px cells). */
function benignNoise(): Uint8Array {
  const c = new Canvas(W, H, BLACK);
  const rnd = prng(0xc0ffee);
  for (let y = 0; y < H; y += 40)
    for (let x = 0; x < W; x += 40) {
      const v = Math.floor(rnd() * 256);
      c.rect(x, y, x + 40, y + 40, [v, Math.floor(rnd() * 256), 255 - v]);
    }
  return c.px;
}

export const PATTERNS = {
  "t0-pattern": t0Pattern,
  "t0-ncii-pattern": t0NciiPattern,
  "benign-gradient": benignGradient,
  "benign-checkerboard": benignCheckerboard,
  "benign-noise": benignNoise,
} as const;
export type PatternName = keyof typeof PATTERNS;
export const BENIGN_PATTERNS: PatternName[] = ["benign-gradient", "benign-checkerboard", "benign-noise"];

export const FIXTURES_DIR = new URL("./", import.meta.url).pathname;

/** The hash media would compute for an encoded fixture. */
export async function fixtureHash(png: Uint8Array) {
  return pdqHash((await decodeImage(png)).luma, 512, 512);
}

export const listText = (name: string, hash: string) =>
  `# SPDX-FileCopyrightText: 2026 CommonAir contributors\n# SPDX-License-Identifier: AGPL-3.0-or-later\n# synthetic fixture: PDQ of ${name}.png, a generated geometric test pattern (packages/moderation/fixtures/generate.ts)\n${hash}\n`;

if (import.meta.main) {
  const pngs = new Map<PatternName, Uint8Array>();
  for (const [name, draw] of Object.entries(PATTERNS) as [PatternName, () => Uint8Array][]) {
    const png = await encodeImage(draw(), { width: W, height: H, format: "rgb" }, "png");
    await Bun.write(`${FIXTURES_DIR}${name}.png`, png);
    pngs.set(name, png);
  }
  const csam = await fixtureHash(pngs.get("t0-pattern") ?? new Uint8Array());
  const ncii = await fixtureHash(pngs.get("t0-ncii-pattern") ?? new Uint8Array());
  await Bun.write(`${FIXTURES_DIR}csam.pdq`, listText("t0-pattern", csam.hash));
  await Bun.write(`${FIXTURES_DIR}ncii.pdq`, listText("t0-ncii-pattern", ncii.hash));
  process.stdout.write(`t0-pattern quality ${csam.quality}, t0-ncii-pattern quality ${ncii.quality}\n`);
}
