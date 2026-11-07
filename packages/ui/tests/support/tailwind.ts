// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Compiles the shipped `globals.css` with the real Tailwind compiler (the same
 * one `@tailwindcss/vite` runs), so tests can check what the browser receives:
 * the generated light-theme selectors and the utilities the tokens create.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile } from "tailwindcss";

const pkgRoot = join(import.meta.dirname, "..", "..");
const stylesDir = join(pkgRoot, "src/styles");

/** CSS packages globals.css imports, by their entry file under this package's node_modules. */
const PACKAGES: Record<string, string> = {
  tailwindcss: "tailwindcss/index.css",
  "tw-animate-css": "tw-animate-css/dist/tw-animate.css",
  "@fontsource-variable/rubik": "@fontsource-variable/rubik/index.css",
};

function resolveStylesheet(id: string, base: string): string {
  if (id.startsWith(".")) return join(base, id);
  const entry = PACKAGES[id];
  if (!entry) throw new Error(`unexpected stylesheet import: ${id}`);
  return join(pkgRoot, "node_modules", entry);
}

/** The CSS Tailwind emits for globals.css when the sources use exactly `candidates`. */
export async function compileGlobals(candidates: string[] = []): Promise<string> {
  const css = readFileSync(join(stylesDir, "globals.css"), "utf8");
  const compiler = await compile(css, {
    base: stylesDir,
    loadStylesheet: async (id, base) => {
      const path = resolveStylesheet(id, base);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(candidates);
}
