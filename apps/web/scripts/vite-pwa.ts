// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The PWA build hook (ADR 0028 decision 7), with no PWA plugin or Workbox:
 *
 * - build, client environment: after the bundle is generated, the shell's files (the entry chunks,
 *   their static imports and the stylesheets they import; never lazy chunks) plus the icons become
 *   the precache list; `src/sw/sw.ts` is built as a classic script (IIFE) with that list, its
 *   hash and the offline page's colours defined, and emitted as `sw.js` next to the assets.
 * - the offline page's colours are the design tokens' own values, read from the token source
 *   (`packages/ui/src/styles/globals.css`) at build time, so the page matches the app without a
 *   colour literal anywhere in the web app (README D7.6).
 * - dev: `/manifest.webmanifest` from `manifestResponse`, and no service worker (the page only
 *   registers one in production builds).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite-plus";
import { PWA_ICON_PATHS } from "../src/pwa/icons.ts";
import { OFFLINE_TOKENS, type OfflinePalette, type OfflineTheme } from "../src/sw/offline-theme.ts";

const SW_ENTRY = fileURLToPath(new URL("../src/sw/sw.ts", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SW_FILE = "sw.js";
export const MANIFEST_PATH = "/manifest.webmanifest";
/** The design tokens' source: the dark theme on `:root, .dark`, the light theme in `@variant light-theme`. */
export const TOKEN_SOURCE = fileURLToPath(new URL("../../../packages/ui/src/styles/globals.css", import.meta.url));

/** The parts of a bundle entry the precache selection reads (Rolldown's output, narrowed). */
export interface ShellBundleItem {
  type: "chunk" | "asset";
  fileName: string;
  isEntry?: boolean;
  /** Static imports (chunk file names); dynamic imports are not followed. */
  imports?: readonly string[];
  /** Stylesheets it imports, and assets it references by URL (the root's `styles.css?url`). */
  viteMetadata?: { importedCss?: ReadonlySet<string>; importedAssets?: ReadonlySet<string> };
}

/**
 * The shell's files as same-origin paths, sorted: every entry chunk, its static imports
 * (transitively) and the stylesheets they import or link, limited to `assets/*.js|css`, plus the
 * icons. Lazy route chunks, fonts and media are left to the browser's HTTP cache.
 */
export function precacheList(bundle: Readonly<Record<string, ShellBundleItem>>): string[] {
  const byName = new Map(Object.values(bundle).map((item) => [item.fileName, item]));
  const files = new Set<string>();
  const queue = Object.values(bundle)
    .filter((item) => item.type === "chunk" && item.isEntry)
    .map((item) => item.fileName);
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || files.has(name)) continue;
    files.add(name);
    const item = byName.get(name);
    for (const css of item?.viteMetadata?.importedCss ?? []) files.add(css);
    for (const asset of item?.viteMetadata?.importedAssets ?? []) if (asset.endsWith(".css")) files.add(asset);
    for (const dep of item?.imports ?? []) queue.push(dep);
  }
  const shell = [...files].filter((f) => /^assets\/[^/]+\.(?:js|css)$/.test(f)).map((f) => `/${f}`);
  return [...shell, ...PWA_ICON_PATHS].sort();
}

/** The cache version: a short hash of the list, so a build with other files gets another cache. */
export function precacheVersion(list: readonly string[], contents: readonly Uint8Array[] = []): string {
  const hash = createHash("sha256").update(list.join("\n"));
  // Hashed file names change with their content; the icons keep theirs, so their bytes count too.
  for (const bytes of contents) hash.update("\0").update(bytes);
  return hash.digest("hex").slice(0, 16);
}

/** The icons' bytes from `public/`, in `PWA_ICON_PATHS` order. */
export function readIconBytes(root: string = WEB_ROOT): Promise<Uint8Array[]> {
  return Promise.all(PWA_ICON_PATHS.map((path) => readFile(join(root, "public", path))));
}

/** The body of the `{ … }` block that `opener` (ending in `{`) opens (blocks nest), or null. */
function blockAfter(css: string, opener: RegExp): string | null {
  const found = opener.exec(css);
  if (!found) return null;
  const open = found.index + found[0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return null;
}

/** A block's own custom properties (`--name: value;`), comments removed. */
export function customProperties(block: string): Map<string, string> {
  const props = new Map<string, string>();
  const plain = block.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of plain.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) if (m[1] && m[2]) props.set(m[1], m[2].trim());
  return props;
}

function paletteFrom(props: Map<string, string>, theme: string): OfflinePalette {
  const entries = Object.entries(OFFLINE_TOKENS).map(([field, token]) => {
    const value = props.get(token);
    // A token that moved or became a var() reference must fail the build, not ship a blank page.
    if (!value || value.includes("var(")) throw new Error(`vite-pwa: no literal ${token} in the ${theme} tokens`);
    return [field, value] as const;
  });
  return Object.fromEntries(entries) as unknown as OfflinePalette;
}

/** The offline page's colours from the token source's text (dark and light themes). */
export function offlineTheme(css: string): OfflineTheme {
  const dark = blockAfter(css, /:root,\s*\.dark\s*\{/);
  const light = blockAfter(css, /@variant\s+light-theme\s*\{/);
  if (dark === null || light === null) throw new Error("vite-pwa: the token source has no dark or light theme block");
  return { dark: paletteFrom(customProperties(dark), "dark"), light: paletteFrom(customProperties(light), "light") };
}

/** The offline page's colours from `TOKEN_SOURCE`. */
export async function readOfflineTheme(path: string = TOKEN_SOURCE): Promise<OfflineTheme> {
  return offlineTheme(await readFile(path, "utf8"));
}

/**
 * An `oklch(L C H)` token as `#rrggbb` (sRGB, clamped), for the places that cannot take oklch:
 * the manifest's colours and `theme-color` (`src/pwa/theme.ts`, checked against the tokens).
 */
export function oklchToHex(value: string): string {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`vite-pwa: not an opaque oklch() colour: ${value}`);
  const lightness = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  const chroma = Number(m[3]);
  const hue = (Number(m[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ];
  const channel = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${linear.map(channel).join("")}`;
}

/** `src/sw/sw.ts` as one classic script with the list defined (a nested build; nothing written). */
export async function buildServiceWorker(
  precache: readonly string[],
  version: string,
  theme: OfflineTheme,
): Promise<string> {
  const result = await build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: "warn",
    publicDir: false,
    define: {
      __PRECACHE__: JSON.stringify(precache),
      __VERSION__: JSON.stringify(version),
      __OFFLINE_THEME__: JSON.stringify(theme),
    },
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      sourcemap: false,
      lib: { entry: SW_ENTRY, formats: ["iife"], name: "commonairServiceWorker", fileName: () => SW_FILE },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const out of outputs)
    if ("output" in out)
      for (const item of out.output) if (item.type === "chunk" && item.fileName === SW_FILE) return item.code;
  throw new Error("vite-pwa: the service worker build produced no sw.js");
}

export function pwa(): Plugin {
  return {
    name: "commonair-pwa",
    configureServer(server) {
      server.middlewares.use(MANIFEST_PATH, (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        // Through Vite's module runner, not an import: the config is loaded by Node, which cannot
        // run the workspace packages' TypeScript (and the build never needs the instance env).
        void (async () => {
          try {
            const { loadWebEnv, publicConfig } = (await server.ssrLoadModule(
              "/src/server/env.ts",
            )) as typeof import("../src/server/env.ts");
            const { manifestResponse } = (await server.ssrLoadModule(
              "/src/server/pwa.ts",
            )) as typeof import("../src/server/pwa.ts");
            const language = req.headers["accept-language"];
            const manifest = manifestResponse(
              publicConfig(loadWebEnv(process.env)),
              typeof language === "string" ? language : null,
            );
            res.statusCode = manifest.status;
            manifest.headers.forEach((value, key) => res.setHeader(key, value));
            res.setHeader("cache-control", "no-store");
            res.end(req.method === "HEAD" ? undefined : await manifest.text());
          } catch (err) {
            next(err);
          }
        })();
      });
    },
    async generateBundle(_options, bundle) {
      if (this.environment.config.consumer !== "client" || this.environment.config.command !== "build") return;
      const list = precacheList(bundle as unknown as Record<string, ShellBundleItem>);
      const theme = await readOfflineTheme();
      const version = precacheVersion(list, await readIconBytes());
      this.emitFile({ type: "asset", fileName: SW_FILE, source: await buildServiceWorker(list, version, theme) });
    },
  };
}
