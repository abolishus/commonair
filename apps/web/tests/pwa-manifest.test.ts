// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The web app manifest and the PWA build hook's precache selection. */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { type ShellBundleItem, precacheList, precacheVersion } from "../scripts/vite-pwa.ts";
import { PWA_ICONS, PWA_ICON_PATHS } from "../src/pwa/icons.ts";
import { PWA_THEME_COLORS } from "../src/pwa/theme.ts";
import type { PublicConfig } from "../src/server/env.ts";
import { MANIFEST_CONTENT_TYPE, manifestResponse, webManifest } from "../src/server/pwa.ts";

const PUBLIC = new URL("../public/", import.meta.url).pathname;

const config: PublicConfig = {
  instanceName: "Riverside Streams",
  publicUrl: "https://riverside.example",
  chatUrl: "wss://riverside.example/chat",
  ingestRtmpUrl: "rtmp://riverside.example/live",
  playbackUrl: "https://riverside.example/hls",
  currency: "eur",
};

describe("web app manifest", () => {
  it("names the instance and starts at the root", async () => {
    const res = manifestResponse(config);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(MANIFEST_CONTENT_TYPE);
    const m = (await res.json()) as Record<string, unknown>;
    expect(m).toMatchObject({
      id: "/",
      name: "Riverside Streams",
      short_name: "Riverside Streams",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
  });

  it("follows another instance's name (no literal name)", () => {
    expect(webManifest({ instanceName: "Other" }).name).toBe("Other");
  });

  it("uses the theme colours", () => {
    const m = webManifest(config);
    expect(m.background_color).toBe(PWA_THEME_COLORS.dark);
    expect(m.theme_color).toBe(PWA_THEME_COLORS.dark);
  });

  it("lists the SVG, 192, 512 and a maskable 512, each of which exists", () => {
    const icons = webManifest(config).icons;
    expect(icons).toEqual([
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
    for (const path of Object.values(PWA_ICONS)) expect(existsSync(`${PUBLIC}${path.slice(1)}`), path).toBe(true);
  });

  it("ships PNGs of the declared sizes, each with a license sidecar", () => {
    const sizes: Record<string, number> = {
      [PWA_ICONS.icon192]: 192,
      [PWA_ICONS.icon512]: 512,
      [PWA_ICONS.maskable512]: 512,
      [PWA_ICONS.appleTouch]: 180,
    };
    for (const [path, size] of Object.entries(sizes)) {
      const png = readFileSync(`${PUBLIC}${path.slice(1)}`);
      expect(png.subarray(1, 4).toString("latin1"), path).toBe("PNG");
      // IHDR: width and height, big-endian, at bytes 16 and 20.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([size, size]);
      expect(readFileSync(`${PUBLIC}${path.slice(1)}.license`, "utf8")).toContain("CC-BY-SA-4.0");
    }
  });
});

describe("precache selection", () => {
  const chunk = (fileName: string, extra: Partial<ShellBundleItem> = {}): ShellBundleItem => ({
    type: "chunk",
    fileName,
    ...extra,
  });
  const asset = (fileName: string): ShellBundleItem => ({ type: "asset", fileName });
  const bundle: Record<string, ShellBundleItem> = {
    "assets/index-a.js": chunk("assets/index-a.js", {
      isEntry: true,
      imports: ["assets/react-b.js", "assets/router-c.js"],
      viteMetadata: { importedCss: new Set(["assets/entry-x.css"]), importedAssets: new Set(["assets/styles-s.css"]) },
    }),
    "assets/react-b.js": chunk("assets/react-b.js", { imports: ["assets/shared-d.js"] }),
    "assets/router-c.js": chunk("assets/router-c.js", { imports: ["assets/shared-d.js"] }),
    "assets/shared-d.js": chunk("assets/shared-d.js", {
      viteMetadata: { importedCss: new Set(["assets/shared-e.css"]), importedAssets: new Set(["assets/font-f.woff2"]) },
    }),
    // Lazy route chunks: reached only by dynamic import.
    "assets/route-studio.js": chunk("assets/route-studio.js", {
      imports: ["assets/route-only.js"],
      viteMetadata: { importedCss: new Set(["assets/route-g.css"]) },
    }),
    "assets/route-only.js": chunk("assets/route-only.js"),
    "assets/styles-s.css": asset("assets/styles-s.css"),
    "assets/font-f.woff2": asset("assets/font-f.woff2"),
    "assets/logo.png": asset("assets/logo.png"),
  };

  it("takes the entry, its static imports and their stylesheets, plus the icons", () => {
    expect(precacheList(bundle)).toEqual(
      [
        "/assets/entry-x.css",
        "/assets/index-a.js",
        "/assets/react-b.js",
        "/assets/router-c.js",
        "/assets/shared-d.js",
        "/assets/shared-e.css",
        "/assets/styles-s.css",
        ...PWA_ICON_PATHS,
      ].sort(),
    );
  });

  it("leaves lazy chunks, fonts and images out", () => {
    const list = precacheList(bundle);
    for (const out of ["route-studio", "route-only", "route-g", "font-f", "logo"])
      expect(
        list.some((p) => p.includes(out)),
        out,
      ).toBe(false);
  });

  it("only lists same-origin /assets/ files and icons", () => {
    const list = precacheList({
      ...bundle,
      "x.js": chunk("x.js", { isEntry: true }),
      "assets/nested/y.js": chunk("assets/nested/y.js", { isEntry: true }),
    });
    for (const p of list) expect(/^\/assets\/[^/]+\.(?:js|css)$/.test(p) || p.startsWith("/icons/"), p).toBe(true);
  });

  it("is only the icons for an empty bundle, and survives an import cycle", () => {
    expect(precacheList({})).toEqual([...PWA_ICON_PATHS]);
    const cyclic = {
      a: chunk("assets/a.js", { isEntry: true, imports: ["assets/b.js"] }),
      b: chunk("assets/b.js", { imports: ["assets/a.js"] }),
    };
    expect(precacheList(cyclic)).toEqual(["/assets/a.js", "/assets/b.js", ...PWA_ICON_PATHS].sort());
  });

  it("versions the list by content", () => {
    const v = precacheVersion(["/assets/a.js"]);
    expect(v).toMatch(/^[0-9a-f]{16}$/);
    expect(precacheVersion(["/assets/a.js"])).toBe(v);
    expect(precacheVersion(["/assets/b.js"])).not.toBe(v);
  });
});
