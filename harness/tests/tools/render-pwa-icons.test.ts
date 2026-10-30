// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The PWA icon renderer's inputs (rendering itself needs Chromium and is run by hand). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { ICONS_DIR, ICON_OUTPUTS, iconPage, svgVariant } from "../../src/tools/render-pwa-icons.ts";

const svg = readFileSync(`${ICONS_DIR}icon.svg`, "utf8");

describe("render-pwa-icons", () => {
  it("renders the four PNGs the manifest and head links name", () => {
    expect(ICON_OUTPUTS.map((o) => [o.file, o.size, o.fullBleed])).toEqual([
      ["icon-192.png", 192, false],
      ["icon-512.png", 512, false],
      ["maskable-512.png", 512, true],
      ["apple-touch-icon.png", 180, true],
    ]);
  });

  it("squares the background off for full-bleed icons only", () => {
    expect(svgVariant(svg, false)).toBe(svg);
    const square = svgVariant(svg, true);
    expect(square).toContain('rx="0"');
    expect(square).not.toBe(svg);
    expect(() => svgVariant("<svg><circle r='1'/></svg>", true)).toThrow("no rounded background");
  });

  it("shows only the icon, inline as a data URL", () => {
    const html = iconPage(svg, 192);
    expect(html).toContain('width="192" height="192"');
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
