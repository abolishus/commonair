// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checks the shipped CSS itself (not a copy of the values): every channel
 * accent pair, chat color, status tone, chart series, sidebar pair and core
 * text pair meets WCAG AA (text) or 3:1 (graphics, focus rings) in both themes,
 * and every focus ring a component draws is a full-opacity token.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCENTS } from "@commonair/contracts/shapes";
import { describe, expect, test } from "vite-plus/test";
import { buttonVariants } from "../src/components/button.tsx";
import { cn } from "../src/lib/utils.ts";
import { accentButtonClasses } from "../src/primitives/accent-button.tsx";
import { contrast, deltaE, mixOklab, tint } from "./support/color.ts";

const BUTTON_VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;

/** The focus-ring color token a button variant actually ends up with (after tailwind-merge, as Button renders). */
function focusRing(variant: (typeof BUTTON_VARIANTS)[number], extra = ""): string[] {
  const classes = cn(buttonVariants({ variant }), extra).split(/\s+/);
  return classes
    .map((c) => /^(?:dark:)?focus-visible:ring-([a-z-]+(?:\/\d+)?)$/.exec(c)?.[1])
    .filter((c): c is string => c !== undefined && !/^(offset|inset|\d)/.test(c));
}

const css = readFileSync(join(import.meta.dirname, "../src/styles/globals.css"), "utf8");

/** Custom properties declared directly in the first rule whose selector text equals `selector`. */
function declarations(selector: string, source = css): Map<string, string> {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`rule not found: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const body = source.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const vars = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const DARK_SELECTOR = ":root,\n.dark";
const dark = declarations(DARK_SELECTOR);
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
const NON_TEXT = 3;
const CHARTS = Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`);
/** Chart series that are also safe as text (4.5:1); the globals.css comments say the same. */
const TEXT_SAFE_CHARTS = { dark: CHARTS, light: CHARTS.filter((c) => c !== "--chart-7") } as const;
const STATUS_TONES = ["--success", "--warning", "--info", "--destructive"] as const;

describe.each(Object.entries(themes))("%s theme", (themeName, theme) => {
  const bg = value(theme, "--background");
  const card = value(theme, "--card");

  test.each(ACCENTS)("channel accent %s: foreground on accent is AA, also on the hover surface", (accent) => {
    const fg = value(theme, `--channel-${accent}-foreground`);
    const surface = value(theme, `--channel-${accent}`);
    expect(contrast(fg, surface)).toBeGreaterThanOrEqual(AA);
    // --color-channel-accent-hover: color-mix(in oklab, accent 88%, --foreground).
    const hover = mixOklab(surface, value(theme, "--foreground"), 0.88);
    expect(contrast(fg, hover)).toBeGreaterThanOrEqual(AA);
    expect(contrast(fg, hover)).toBeGreaterThanOrEqual(contrast(fg, surface));
  });

  test.each(Array.from({ length: 12 }, (_, i) => i + 1))("chat color %i is AA on background and card", (i) => {
    const color = value(theme, `--chat-${i}`);
    expect(contrast(color, bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(color, card, bg)).toBeGreaterThanOrEqual(AA);
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
    ["--sidebar-foreground", "--sidebar"],
    ["--sidebar-accent-foreground", "--sidebar-accent"],
    ["--sidebar-primary-foreground", "--sidebar-primary"],
    ["--muted-foreground", "--sidebar"],
  ])("%s on %s is AA", (fg, surface) => {
    expect(contrast(value(theme, fg), value(theme, surface), bg)).toBeGreaterThanOrEqual(AA);
  });

  test.each(STATUS_TONES)(
    "status tone %s is AA as text on background, card and its own 10-15 %% tint over either",
    (tone) => {
      const color = value(theme, tone);
      expect(contrast(color, bg)).toBeGreaterThanOrEqual(AA);
      expect(contrast(color, card, bg)).toBeGreaterThanOrEqual(AA);
      for (const surface of [bg, card]) {
        for (const alpha of [0.1, 0.15]) {
          expect(contrast(color, tint(color, alpha, surface))).toBeGreaterThanOrEqual(AA);
        }
      }
    },
  );

  test.each(CHARTS)("%s is at least 3:1 on background and card (graphics)", (chart) => {
    expect(contrast(value(theme, chart), bg)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast(value(theme, chart), card, bg)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  test("text-safe chart colors are AA on background and card", () => {
    for (const chart of TEXT_SAFE_CHARTS[themeName as keyof typeof TEXT_SAFE_CHARTS]) {
      expect(contrast(value(theme, chart), bg), chart).toBeGreaterThanOrEqual(AA);
      expect(contrast(value(theme, chart), card, bg), chart).toBeGreaterThanOrEqual(AA);
    }
  });

  test("the eight chart colors are mutually distinguishable", () => {
    const colors = CHARTS.map((c) => value(theme, c));
    expect(new Set(colors).size).toBe(colors.length);
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        expect(deltaE(colors[i]!, colors[j]!), `${CHARTS[i]} vs ${CHARTS[j]}`).toBeGreaterThanOrEqual(0.05);
      }
    }
  });

  test.each(BUTTON_VARIANTS)(
    "button %s: full-opacity focus ring with 3:1 on background, card and popover",
    (variant) => {
      const rings = focusRing(variant);
      expect(rings).toHaveLength(1);
      const token = rings[0]!;
      expect(token).not.toContain("/");
      for (const surface of ["--background", "--card", "--popover"]) {
        expect(contrast(value(theme, `--${token}`), value(theme, surface), bg)).toBeGreaterThanOrEqual(NON_TEXT);
      }
    },
  );

  test("AccentButton keeps Button's full-opacity ring", () => {
    expect(focusRing("default", accentButtonClasses)).toEqual(["ring"]);
  });

  test("focus ring is visible against the background (non-text 3:1)", () => {
    expect(contrast(value(theme, "--ring"), bg)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  test("sidebar group labels (sidebar-foreground at 70 %) stay AA on the sidebar", () => {
    const sidebar = value(theme, "--sidebar");
    expect(contrast(tint(value(theme, "--sidebar-foreground"), 0.7, sidebar), sidebar)).toBeGreaterThanOrEqual(AA);
  });

  test("sidebar ring is 3:1 on the sidebar and its accent surface", () => {
    for (const surface of ["--sidebar", "--sidebar-accent"]) {
      expect(contrast(value(theme, "--sidebar-ring"), value(theme, surface), bg)).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });

  test("overlay text stays AA even over a white or black thumbnail", () => {
    for (const thumbnail of ["#ffffff", "#000000"]) {
      expect(
        contrast(value(theme, "--overlay-foreground"), value(theme, "--overlay"), thumbnail),
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  /** The surface each ring token is drawn against, besides background/card/popover. */
  const RING_SURFACES: Record<string, string[]> = {
    ring: ["--background", "--card", "--popover", "--muted"],
    destructive: ["--background", "--card", "--popover"],
    "sidebar-ring": ["--sidebar", "--sidebar-accent"],
  };

  test.each(componentRings())("%s: focus ring token %s is full-opacity and 3:1", (_file, token) => {
    expect(token).not.toContain("/");
    const surfaces = RING_SURFACES[token];
    expect(surfaces, `unexpected ring token ${token}`).toBeDefined();
    for (const surface of surfaces ?? []) {
      expect(contrast(value(theme, `--${token}`), value(theme, surface), bg), surface).toBeGreaterThanOrEqual(NON_TEXT);
    }
  });
});

/**
 * Every focus-indicator ring color in src/components: utilities like
 * `focus-visible:ring-ring`, `focus-within:ring-ring`,
 * `has-[…:focus-visible]:ring-ring`, `group-focus-visible/x:ring-…`.
 */
function componentRings(): [string, string][] {
  const dir = join(import.meta.dirname, "../src/components");
  const out: [string, string][] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const seen = new Set<string>();
    for (const cls of text.split(/[\s"'`]+/)) {
      if (!cls.includes("focus")) continue;
      const m = /:ring-([a-z][a-z-]*(?:\/\d+)?)$/.exec(cls);
      if (!m || /^(offset|inset)/.test(m[1]!)) continue;
      seen.add(m[1]!);
    }
    // Slider thumbs and sidebar buttons set the ring color unprefixed (`ring-sidebar-ring … focus-visible:ring-2`).
    if (file === "slider.tsx" || file === "sidebar.tsx") {
      for (const m of text.matchAll(/[\s"]ring-([a-z][a-z-]*(?:\/\d+)?)(?=[\s"])/g)) {
        if (!/^(offset|inset)/.test(m[1]!)) seen.add(m[1]!);
      }
    }
    for (const token of seen) out.push([file, token]);
  }
  return out;
}

describe("focus rings in components", () => {
  test("every focusable component the brief lists draws a ring we check", () => {
    const files = new Set(componentRings().map(([file]) => file));
    for (const file of [
      "button.tsx",
      "input.tsx",
      "select.tsx",
      "textarea.tsx",
      "checkbox.tsx",
      "switch.tsx",
      "radio-group.tsx",
      "slider.tsx",
      "toggle.tsx",
      "tabs.tsx",
      "input-group.tsx",
      "combobox.tsx",
      "sidebar.tsx",
      "item.tsx",
      "accordion.tsx",
      "badge.tsx",
      "navigation-menu.tsx",
      "scroll-area.tsx",
    ]) {
      expect(files, file).toContain(file);
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

  test("`.dark` re-applies the dark tokens (inverted menus) and the dark: variant matches it", () => {
    expect(css).toContain(`${DARK_SELECTOR} {`);
    expect(css).toMatch(/&:where\(\.dark, \.dark \*\)/);
  });

  test("every new token has a Tailwind color utility", () => {
    for (const name of [
      ...CHARTS,
      "--success",
      "--warning",
      "--info",
      "--sidebar",
      "--sidebar-foreground",
      "--sidebar-primary",
      "--sidebar-primary-foreground",
      "--sidebar-accent",
      "--sidebar-accent-foreground",
      "--sidebar-border",
      "--sidebar-ring",
    ]) {
      expect(css).toContain(`--color-${name.slice(2)}: var(${name});`);
    }
  });

  test("Rubik is the only font family, self-hosted, including the mono stack", () => {
    expect(css).toContain('@import "@fontsource-variable/rubik";');
    const stack = '"Rubik Variable", ui-sans-serif, system-ui, sans-serif';
    expect(css).toContain(`--font-sans: ${stack};`);
    expect(css).toContain(`--font-display: ${stack};`);
    expect(css).toContain(`--font-mono: ${stack};`);
    expect(css).not.toMatch(/https?:\/\//);
  });

  test("reduced motion disables animations and transitions", () => {
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms !important/);
  });
});
