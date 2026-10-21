// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Regenerate `decoded/*.512.rgb.gz`: the reference photos decoded the way upstream's
 * `pdq-photo-hasher` reads them, so the unit tests can check the port bit for bit without a JPEG
 * decoder. Upstream builds CImg without `cimg_use_jpeg`, so CImg decodes through libjpeg
 * (ImageMagick) and then `resize(512, 512)` with its default nearest-neighbour interpolation
 * (source index `floor(x * W / 512)`), because the photos are larger than 512 px. Here libjpeg-turbo's
 * `djpeg -ppm` (ISLOW DCT, fancy upsampling: libjpeg's defaults) does the decode.
 *
 *   bun packages/moderation/tests/vectors/make-decoded.ts   (needs djpeg on PATH)
 */
import { mkdirSync } from "node:fs";

export const DECODED = ["bridge-1-original"] as const;
const dir = new URL("./", import.meta.url).pathname;

export function parsePpm(b: Uint8Array) {
  let pos = 0;
  const ws = (c: number | undefined) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  const tok = () => {
    while (ws(b[pos])) pos++;
    let s = "";
    while (pos < b.length && !ws(b[pos])) s += String.fromCharCode(b[pos++] ?? 0);
    return s;
  };
  const magic = tok();
  const w = Number(tok());
  const h = Number(tok());
  const max = Number(tok());
  pos++;
  if (magic !== "P6" || max !== 255) throw new Error("expected an 8-bit binary PPM");
  return { w, h, rgb: b.subarray(pos, pos + w * h * 3) };
}

/** CImg `resize(sx, sy)` with interpolation type 1 (nearest neighbour) on packed RGB. */
export function cimgNearest(rgb: Uint8Array, w: number, h: number, sx: number, sy: number) {
  const out = new Uint8Array(sx * sy * 3);
  for (let y = 0; y < sy; y++) {
    const iy = Math.floor((y * h) / sy);
    for (let x = 0; x < sx; x++) {
      const ix = Math.floor((x * w) / sx);
      for (let c = 0; c < 3; c++) out[(y * sx + x) * 3 + c] = rgb[(iy * w + ix) * 3 + c] ?? 0;
    }
  }
  return out;
}

if (import.meta.main) {
  mkdirSync(`${dir}decoded`, { recursive: true });
  for (const name of DECODED) {
    const p = Bun.spawnSync(["djpeg", "-ppm", `${dir}dih/${name}.jpg`]);
    if (p.exitCode !== 0) throw new Error(`djpeg failed for ${name}`);
    const { w, h, rgb } = parsePpm(new Uint8Array(p.stdout));
    await Bun.write(`${dir}decoded/${name}.512.rgb.gz`, Bun.gzipSync(cimgNearest(rgb, w, h, 512, 512), { level: 9 }));
    console.log(`${name}: ${w}x${h} -> 512x512`);
  }
}
