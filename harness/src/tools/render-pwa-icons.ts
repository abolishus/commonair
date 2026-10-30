// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Renders the web app's PNG icons from `apps/web/public/icons/icon.svg` with the harness's
 * Playwright Chromium (ADR 0028 decision 7). It lives in the harness because only the harness
 * depends on Playwright. No scenario imports it.
 *
 * Rerun after changing the SVG, then commit the PNGs (their `.license` sidecars stay as they are):
 *
 *   bun harness/src/tools/render-pwa-icons.ts            (needs `bun run --filter @commonair/harness browsers` once)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

export const ICONS_DIR = new URL("../../../apps/web/public/icons/", import.meta.url).pathname;

export interface IconOutput {
  file: string;
  size: number;
  /**
   * Full bleed: the background fills the square (maskable icons are cropped by the platform, and
   * iOS rounds the apple-touch icon itself). Otherwise the SVG's rounded corners stay transparent.
   */
  fullBleed: boolean;
}

export const ICON_OUTPUTS: readonly IconOutput[] = [
  { file: "icon-192.png", size: 192, fullBleed: false },
  { file: "icon-512.png", size: 512, fullBleed: false },
  { file: "maskable-512.png", size: 512, fullBleed: true },
  { file: "apple-touch-icon.png", size: 180, fullBleed: true },
];

const CORNER = /(<rect\b[^>]*\brx=")\d+(")/;

/** The SVG for one output: full bleed drops the background's corner radius. */
export function svgVariant(svg: string, fullBleed: boolean): string {
  if (!fullBleed) return svg;
  if (!CORNER.test(svg)) throw new Error("icon.svg: no rounded background <rect rx> to square off");
  return svg.replace(CORNER, "$10$2");
}

/** A page that shows only the icon at `size` CSS pixels on a transparent background. */
export function iconPage(svg: string, size: number): string {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return `<!doctype html><html><head><style>html,body{margin:0;background:transparent}img{display:block}</style></head><body><img src="${src}" width="${size}" height="${size}" alt=""></body></html>`;
}

export async function renderIcons(dir = ICONS_DIR): Promise<string[]> {
  const svg = readFileSync(join(dir, "icon.svg"), "utf8");
  const browser = await chromium.launch();
  const written: string[] = [];
  try {
    for (const out of ICON_OUTPUTS) {
      const page = await browser.newPage({ viewport: { width: out.size, height: out.size }, deviceScaleFactor: 1 });
      await page.setContent(iconPage(svgVariant(svg, out.fullBleed), out.size));
      await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
      const png = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: out.size, height: out.size },
      });
      const path = join(dir, out.file);
      writeFileSync(path, png);
      written.push(path);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return written;
}

if (import.meta.main) {
  for (const path of await renderIcons()) process.stdout.write(`wrote ${path}\n`);
}
