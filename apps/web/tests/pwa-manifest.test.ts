// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The web app manifest and the PWA build hook's precache selection. */
import { PROTECTED_LITERALS, SITE } from "@commonair/config/site";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  type ShellBundleItem,
  TOKEN_SOURCE,
  customProperties,
  offlineTheme,
  oklchToHex,
  precacheList,
  precacheVersion,
  readIconBytes,
  readOfflineTheme,
} from "../scripts/vite-pwa.ts";
import en from "../src/i18n/locales/en/d7-pwa.json" with { type: "json" };
import es from "../src/i18n/locales/es/d7-pwa.json" with { type: "json" };
import { PWA_ICONS, PWA_ICON_PATHS } from "../src/pwa/icons.ts";
import { PWA_THEME_COLORS } from "../src/pwa/theme.ts";
import type { PublicConfig } from "../src/server/env.ts";
import {
  MANIFEST_CONTENT_TYPE,
  PWA_SCREENSHOTS,
  PWA_SHORTCUTS,
  manifestResponse,
  webManifest,
} from "../src/server/pwa.ts";
import { OFFLINE_TOKENS } from "../src/sw/offline-theme.ts";

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
    const m = webManifest({ instanceName: "Other" });
    expect(m.name).toBe("Other");
    expect(m.short_name).toBe("Other");
    expect(m.description).toBe("Live streams and chat on Other, a platform its members own.");
  });

  it("carries no domain, URL or project name of its own (check-domains)", () => {
    const m = webManifest({ instanceName: "Other" });
    const text = JSON.stringify(m).toLowerCase();
    expect(text).not.toMatch(/https?:/);
    for (const literal of [...PROTECTED_LITERALS, SITE.name]) expect(text).not.toContain(literal.toLowerCase());
    expect([m.id, m.start_url, m.scope]).toEqual(["/", "/", "/"]);
    // Every URL in it is a path on the instance itself.
    for (const url of [...m.shortcuts.map((s) => s.url), ...m.screenshots.map((s) => s.src)])
      expect(url.startsWith("/") && !url.startsWith("//"), url).toBe(true);
  });

  it("describes the app with categories, in the requester's language", async () => {
    const english = webManifest(config);
    expect(english).toMatchObject({
      lang: "en",
      dir: "ltr",
      categories: ["entertainment", "social"],
      description: "Live streams and chat on Riverside Streams, a platform its members own.",
    });
    const spanish = webManifest(config, ["es-ES", "en"]);
    expect(spanish.lang).toBe("es");
    expect(spanish.description).toBe("Directos y chat en Riverside Streams, una plataforma de sus miembros.");
    expect(webManifest(config, ["de"]).lang).toBe("en");

    const res = manifestResponse(config, "es-MX,es;q=0.9,en;q=0.5");
    expect(res.headers.get("content-language")).toBe("es");
    expect(res.headers.get("vary")).toBe("accept-language");
    expect(((await res.json()) as { lang: string }).lang).toBe("es");
    expect(manifestResponse(config).headers.get("content-language")).toBe("en");
  });

  it("offers the four shortcuts, named from the catalog", () => {
    expect(webManifest(config).shortcuts).toEqual(
      [
        ["Following", "/following"],
        ["Browse", "/directory"],
        ["Creator studio", "/dashboard"],
        ["Inbox", "/inbox"],
      ].map(([name, url]) => ({
        name,
        short_name: name,
        url,
        icons: [{ src: PWA_ICONS.icon192, sizes: "192x192", type: "image/png" }],
      })),
    );
    expect(webManifest(config, ["es"]).shortcuts.map((s) => s.name)).toEqual(PWA_SHORTCUTS.map((s) => es[s.key]));
    for (const s of PWA_SHORTCUTS) expect(en[s.key].length).toBeGreaterThan(0);
  });

  it("lists a narrow and a wide screenshot, each a PNG of its declared size with a license", () => {
    const shots = webManifest(config).screenshots;
    expect(shots.map((s) => [s.form_factor, s.src, s.sizes, s.type])).toEqual([
      ["narrow", "/screenshots/narrow.png", "750x1334", "image/png"],
      ["wide", "/screenshots/wide.png", "1440x900", "image/png"],
    ]);
    expect(shots.map((s) => s.label)).toEqual([en["d7Pwa.screenshot.narrow"], en["d7Pwa.screenshot.wide"]]);
    for (const shot of Object.values(PWA_SCREENSHOTS)) {
      const file = `${PUBLIC}${shot.src.slice(1)}`;
      const png = readFileSync(file);
      expect(png.subarray(1, 4).toString("latin1"), shot.src).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], shot.src).toEqual([shot.width, shot.height]);
      expect(readFileSync(`${file}.license`, "utf8")).toContain("CC-BY-SA-4.0");
      // The art it was rendered from sits beside it, self-made and licensed.
      expect(readFileSync(file.replace(/\.png$/, ".svg"), "utf8")).toContain("SPDX-License-Identifier: CC-BY-SA-4.0");
    }
  });

  it("uses the theme colours", () => {
    const m = webManifest(config);
    expect(m.background_color).toBe(PWA_THEME_COLORS.dark);
    expect(m.theme_color).toBe(PWA_THEME_COLORS.dark);
  });

  it("has theme colours that are the design tokens' backgrounds", async () => {
    const theme = await readOfflineTheme();
    expect(oklchToHex(theme.dark.background)).toBe(PWA_THEME_COLORS.dark);
    expect(oklchToHex(theme.light.background)).toBe(PWA_THEME_COLORS.light);
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

describe("token colours at build time", () => {
  it("reads every offline-page token from both themes of the token source", async () => {
    const theme = await readOfflineTheme();
    expect(TOKEN_SOURCE.endsWith("packages/ui/src/styles/globals.css")).toBe(true);
    for (const palette of [theme.dark, theme.light])
      for (const value of Object.values(palette)) expect(value).toMatch(/^oklch\(/);
    expect(theme.dark.background).not.toBe(theme.light.background);
    expect(Object.keys(theme.dark).sort()).toEqual(Object.keys(OFFLINE_TOKENS).sort());
  });

  it("parses a theme block's own properties and fails loudly when a token is missing", () => {
    const css = `:root,
.dark {
  /* note: a comment; with --fake: no */
  --background: oklch(0.1 0 0);
  --foreground: oklch(0.9 0 0);
  --muted-foreground: oklch(0.7 0 0);
  --border: oklch(1 0 0 / 10%);
  --primary: oklch(0.9 0 0);
  --primary-foreground: oklch(0.2 0 0);
  --ring: oklch(0.7 0 0);
}
* {
  @variant light-theme {
    --background: oklch(1 0 0);
    --foreground: oklch(0.1 0 0);
    --muted-foreground: oklch(0.5 0 0);
    --border: oklch(0.9 0 0);
    --primary: oklch(0.2 0 0);
    --primary-foreground: oklch(0.98 0 0);
    --ring: oklch(0.5 0 0);
  }
}`;
    expect(offlineTheme(css).light.background).toBe("oklch(1 0 0)");
    expect(offlineTheme(css).dark.border).toBe("oklch(1 0 0 / 10%)");
    expect(customProperties("--a: 1; /* --b: 2; */ --c: x y;")).toEqual(
      new Map([
        ["--a", "1"],
        ["--c", "x y"],
      ]),
    );
    expect(() => offlineTheme(css.replace("--ring: oklch(0.5 0 0);", "--ring: var(--x);"))).toThrow(/--ring/);
    expect(() => offlineTheme("body { color: red }")).toThrow(/theme block/);
  });

  it("converts oklch to sRGB hex", () => {
    expect(oklchToHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(oklchToHex("oklch(0 0 0)")).toBe("#000000");
    expect(oklchToHex("oklch(0.141 0.005 285.823)")).toBe("#09090b");
    expect(oklchToHex("oklch(62.8% 0.2577 29.23)")).toBe("#ff0000");
    expect(() => oklchToHex("oklch(1 0 0 / 10%)")).toThrow(/not an opaque/);
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

  it("versions the icons by their bytes, whose names never change", async () => {
    const list = ["/assets/a.js", ...PWA_ICON_PATHS];
    const a = precacheVersion(list, [new Uint8Array([1, 2])]);
    expect(precacheVersion(list, [new Uint8Array([1, 2])])).toBe(a);
    expect(precacheVersion(list, [new Uint8Array([1, 3])])).not.toBe(a);
    expect(precacheVersion(list, [new Uint8Array([1]), new Uint8Array([2])])).not.toBe(a);
    const icons = await readIconBytes();
    expect(icons).toHaveLength(PWA_ICON_PATHS.length);
    for (const bytes of icons) expect(bytes.length).toBeGreaterThan(0);
  });
});
