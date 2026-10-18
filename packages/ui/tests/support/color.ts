// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Just enough color math to check WCAG contrast of the CSS tokens we ship:
 * parses `#rgb`, `#rrggbb` and `oklch(L C H [/ alpha])`, converts to sRGB
 * (clamped, as an sRGB display would show it), and computes WCAG 2 ratios.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

function parseHex(value: string): Rgba {
  let hex = value.slice(1);
  if (hex.length === 3)
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`bad hex color: ${value}`);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
    a: 1,
  };
}

const toGamma = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

function parseOklch(value: string): Rgba {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (!m) throw new Error(`bad oklch color: ${value}`);
  const l = Number(m[1]) / (m[2] ? 100 : 1);
  const c = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] ? 100 : 1);
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  // OKLab -> LMS -> linear sRGB (Björn Ottosson's reference matrices).
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: toGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: toGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: toGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    a: alpha,
  };
}

export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v.startsWith("#")) return parseHex(v);
  if (v.startsWith("oklch(")) return parseOklch(v);
  throw new Error(`unsupported color: ${value}`);
}

/** Composites a (possibly translucent) color over an opaque backdrop. */
export function over(top: Rgba, backdrop: Rgba): Rgba {
  return {
    r: top.r * top.a + backdrop.r * (1 - top.a),
    g: top.g * top.a + backdrop.g * (1 - top.a),
    b: top.b * top.a + backdrop.b * (1 - top.a),
    a: 1,
  };
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance({ r, g, b }: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio, 1..21. Translucent colors are composited over `backdrop`. */
export function contrast(fg: string, bg: string, backdrop = "#000000"): number {
  const base = parseColor(backdrop);
  const b = over(parseColor(bg), base);
  const f = over(parseColor(fg), b);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
