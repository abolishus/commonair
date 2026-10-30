// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The PWA build hook (ADR 0028 decision 7), with no PWA plugin or Workbox:
 *
 * - build, client environment: after the bundle is generated, the shell's files (the entry chunks,
 *   their static imports and the stylesheets they import; never lazy chunks) plus the icons become
 *   the precache list; `src/sw/sw.ts` is built as a classic script (IIFE) with that list and its
 *   hash defined, and emitted as `sw.js` next to the assets.
 * - dev: `/manifest.webmanifest` from `manifestResponse`, and no service worker (the page only
 *   registers one in production builds).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite-plus";
import { PWA_ICON_PATHS } from "../src/pwa/icons.ts";

const SW_ENTRY = fileURLToPath(new URL("../src/sw/sw.ts", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SW_FILE = "sw.js";
export const MANIFEST_PATH = "/manifest.webmanifest";

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

/** `src/sw/sw.ts` as one classic script with the list defined (a nested build; nothing written). */
export async function buildServiceWorker(precache: readonly string[], version: string): Promise<string> {
  const result = await build({
    configFile: false,
    root: WEB_ROOT,
    logLevel: "warn",
    publicDir: false,
    define: {
      __PRECACHE__: JSON.stringify(precache),
      __VERSION__: JSON.stringify(version),
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
            const manifest = manifestResponse(publicConfig(loadWebEnv(process.env)));
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
      const version = precacheVersion(list, await readIconBytes());
      this.emitFile({ type: "asset", fileName: SW_FILE, source: await buildServiceWorker(list, version) });
    },
  };
}
