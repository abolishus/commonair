// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checks the shipped CSS itself (not a copy of the values): every channel
 * accent pair, chat color and core text pair meets WCAG AA in both themes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCENTS } from "@commonair/contracts/shapes";
import { describe, expect, test } from "vite-plus/test";
import { contrast } from "./support/color.ts";

const css = readFileSync(join(import.meta.dirname, "../src/styles/globals.css"), "utf8");

/** Custom properties declared directly in the first rule whose selector text equals `selector`. */
function declarations(selector: string, source = css): Map<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const body = source.slice(open + 1, close);
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const dark = declarations(":root");
const lightExplicit = declarations('.light,\n[data-theme="light"]');
const systemMedia = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));
const lightSystem = declarations('  [data-theme="system"]', systemMedia);
/** Light values resolve over the dark defaults they do not override. */
const light = new Map([...dark, ...lightExplicit]);

const themes = { dark, light } as const;

function value(theme: Map<string, string>, name: string): string {
  const v = theme.get(name);
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

const AA = 4.5;

describe.each(Object.entries(themes))("%s theme", (_name, theme) => {
  const bg = value(theme, "--background");

  test.each(ACCENTS)("channel accent %s: foreground on accent is AA", (accent) => {
    const fg = value(theme, `--channel-${accent}-foreground`);
    const surface = value(theme, `--channel-${accent}`);
    expect(contrast(fg, surface)).toBeGreaterThanOrEqual(AA);
  });

  test.each(Array.from({ length: 12 }, (_, i) => i + 1))("chat color %i is AA on background and card", (i) => {
    const color = value(theme, `--chat-${i}`);
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(color, value(theme, "--card"), bg)).toBeGreaterThanOrEqual(AA);
  });

  test.each([
    ["--foreground", "--background"],
    ["--card-foreground", "--card"],
    ["--popover-foreground", "--popover"],
    ["--primary-foreground", "--primary"],
    ["--secondary-foreground", "--secondary"],
    ["--accent-foreground", "--accent"],
    ["--muted-foreground", "--muted"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--card"],
    ["--destructive", "--background"],
    ["--live-foreground", "--live"],
  ])("%s on %s is AA", (fg, surface) => {
    expect(contrast(value(theme, fg), value(theme, surface), bg)).toBeGreaterThanOrEqual(AA);
  });

  test("focus ring is visible against the background (non-text 3:1)", () => {
    expect(contrast(value(theme, "--ring"), bg)).toBeGreaterThanOrEqual(3);
  });

  test("overlay text stays AA even over a white or black thumbnail", () => {
    for (const thumbnail of ["#ffffff", "#000000"]) {
      expect(
        contrast(value(theme, "--overlay-foreground"), value(theme, "--overlay"), thumbnail),
      ).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe("theme structure", () => {
  test("every accent has a [data-accent] rule mapping to its tokens", () => {
    for (const accent of ACCENTS) {
      const rule = accent === "zinc" ? `:root,\n[data-accent="zinc"]` : `[data-accent="${accent}"]`;
      const vars = declarations(rule);
      expect(vars.get("--channel-accent")).toBe(`var(--channel-${accent})`);
      expect(vars.get("--channel-accent-foreground")).toBe(`var(--channel-${accent}-foreground)`);
    }
  });

  test('the "system" light block is identical to the explicit light block', () => {
    expect(Object.fromEntries(lightSystem)).toEqual(Object.fromEntries(lightExplicit));
  });

  test("the light theme overrides every color the dark theme defines (except theme-independent ones)", () => {
    const independent = new Set(["--radius", "--overlay", "--overlay-foreground"]);
    const missing = [...dark.keys()].filter((k) => !independent.has(k) && !lightExplicit.has(k));
    expect(missing).toEqual([]);
  });

  test("Rubik is the only font family, self-hosted", () => {
    expect(css).toContain('@import "@fontsource-variable/rubik";');
    const stack = '"Rubik Variable", ui-sans-serif, system-ui, sans-serif';
    expect(css).toContain(`--font-sans: ${stack};`);
    expect(css).toContain(`--font-display: ${stack};`);
    expect(css).not.toMatch(/https?:\/\//);
  });

  test("reduced motion disables animations and transitions", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
  });
});
