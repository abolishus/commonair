// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checks the shipped CSS itself (not a copy of the values): every channel
 * accent pair, chat color, status tone, chart series, sidebar pair, surface,
 * brand pair and core text pair meets WCAG AA (text) or 3:1 (graphics, focus
 * rings) in both themes, no palette color sits within reach of the brand, every
 * focus ring a component draws is a full-opacity token at the one focus rule,
 * and the compiled CSS (real Tailwind) carries the light theme for both the
 * explicit choice and "system". The pairs are the ones in
 * docs/design/2026-11-overhaul/round2/direction-check.md.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCENTS } from "@commonair/contracts/shapes";
import { describe, expect, test } from "vite-plus/test";
import { buttonVariants } from "../src/components/button.tsx";
import { cn } from "../src/lib/utils.ts";
import { accentButtonClasses } from "../src/primitives/accent-button.tsx";
import { contrast, deltaE, luminance, mixOklab, parseColor, tint } from "./support/color.ts";
import { compileGlobals } from "./support/tailwind.ts";

const BUTTON_VARIANTS = ["default", "outline", "secondary", "ghost", "destructive", "link", "brand"] as const;

/** The focus-ring color token a button variant actually ends up with (after tailwind-merge, as Button renders). */
function focusRing(variant: (typeof BUTTON_VARIANTS)[number], extra = ""): string[] {
  const classes = cn(buttonVariants({ variant }), extra).split(/\s+/);
  return classes
    .map((c) => /^(?:dark:)?focus-visible:ring-([a-z-]+(?:\/\d+)?)$/.exec(c)?.[1])
    .filter((c): c is string => c !== undefined && !/^(offset|inset|\d)/.test(c));
}

const css = readFileSync(join(import.meta.dirname, "../src/styles/globals.css"), "utf8");

/** The body of the first `<opener> { … }` in `source`, braces matched. */
function block(source: string, opener: string): string {
  const start = source.indexOf(`${opener} {`);
  if (start < 0) throw new Error(`rule not found: ${opener}`);
  const open = source.indexOf("{", start + opener.length);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unclosed rule: ${opener}`);
}

/** Custom properties declared in a rule body (a nested `@supports` fallback is overridden by its later value). */
function parse(body: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    vars.set(m[1]!, m[2]!.trim());
  }
  return vars;
}

const DARK_SELECTOR = ":root,\n.dark";
/** Theme-independent tokens (radius, motion, overlay, scrim). */
const independent = parse(block(css, "\n:root"));
const darkOwn = parse(block(css, DARK_SELECTOR));
/** The light theme as written: once, inside `@variant light-theme`. */
const lightSource = block(css, "@variant light-theme");
const lightOwn = parse(lightSource);
const dark = new Map([...independent, ...darkOwn]);
/** Light values resolve over the dark defaults they do not override. */
const light = new Map([...dark, ...lightOwn]);

const themes = { dark, light } as const;

function raw(theme: Map<string, string>, name: string): string {
  const v = theme.get(name);
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

/** A token's color, following `var()` and `color-mix(in oklab, a N%, b)` as the browser would. */
function value(theme: Map<string, string>, name: string): string {
  return resolve(theme, raw(theme, name));
}

function resolve(theme: Map<string, string>, v: string, depth = 0): string {
  if (depth > 8) throw new Error(`var() cycle at ${v}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return resolve(theme, raw(theme, ref[1]!), depth + 1);
  const mix = /^color-mix\(in oklab,\s*(var\(--[\w-]+\)|[^,]+?)\s+([\d.]+)%,\s*(var\(--[\w-]+\)|[^)]+)\)$/.exec(v);
  if (mix) {
    return mixOklab(resolve(theme, mix[1]!, depth + 1), resolve(theme, mix[3]!, depth + 1), Number(mix[2]) / 100);
  }
  return v;
}

const AA = 4.5;
const NON_TEXT = 3;
/** Minimum OKLab distance from --brand for any palette color (#fbbf24 was 0.012; #fde047 is 0.086). */
const BRAND_DISTANCE = 0.07;
const CHARTS = Array.from({ length: 8 }, (_, i) => `--chart-${i + 1}`);
const CHATS = Array.from({ length: 12 }, (_, i) => `--chat-${i + 1}`);
/** Chart series that are also safe as text (4.5:1); the globals.css comments say the same. */
const TEXT_SAFE_CHARTS = { dark: CHARTS, light: CHARTS.filter((c) => c !== "--chart-7") } as const;
const STATUS_TONES = ["--success", "--warning", "--info", "--destructive"] as const;
/** The surface levels text sits on: page, sunken, card, raised (popovers), plus the muted fill. */
const SURFACES = ["--background", "--surface-sunken", "--card", "--surface-raised", "--popover", "--muted"] as const;

describe.each(Object.entries(themes))("%s theme", (themeName, theme) => {
  const bg = value(theme, "--background");
  const card = value(theme, "--card");
  const brand = value(theme, "--brand");

  test.each(ACCENTS)("channel accent %s: foreground on accent is AA, also on the hover surface", (accent) => {
    const fg = value(theme, `--channel-${accent}-foreground`);
    const surface = value(theme, `--channel-${accent}`);
    expect(contrast(fg, surface)).toBeGreaterThanOrEqual(AA);
    // --color-channel-accent-hover: color-mix(in oklab, accent 88%, --foreground).
    const hover = mixOklab(surface, value(theme, "--foreground"), 0.88);
    expect(contrast(fg, hover)).toBeGreaterThanOrEqual(AA);
    expect(contrast(fg, hover)).toBeGreaterThanOrEqual(contrast(fg, surface));
  });

  test.each(ACCENTS)("channel accent %s: the fill stands out from the page and card (3:1)", (accent) => {
    const fill = value(theme, `--channel-${accent}`);
    expect(contrast(fill, bg)).toBeGreaterThanOrEqual(NON_TEXT);
    expect(contrast(fill, card)).toBeGreaterThanOrEqual(NON_TEXT);
  });

  test.each(CHATS)("%s is AA on background and card", (chat) => {
    const color = value(theme, chat);
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

  test.each(SURFACES)("body text (foreground and muted-foreground) is AA on %s", (surface) => {
    for (const fg of ["--foreground", "--muted-foreground"]) {
      expect(contrast(value(theme, fg), value(theme, surface), bg), fg).toBeGreaterThanOrEqual(AA);
    }
  });

  test.each(STATUS_TONES)(
    "status tone %s is AA as text on every surface and on its own 10-15 %% tint over background or card",
    (tone) => {
      const color = value(theme, tone);
      for (const surface of SURFACES) {
        expect(contrast(color, value(theme, surface), bg), surface).toBeGreaterThanOrEqual(AA);
      }
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

  describe("brand", () => {
    test("brand-foreground on the brand fill is AA, and stays AA on the hover surface", () => {
      const fg = value(theme, "--brand-foreground");
      expect(contrast(fg, brand)).toBeGreaterThanOrEqual(AA);
      // --color-brand-hover: color-mix(in oklab, --brand 88%, --foreground).
      expect(contrast(fg, mixOklab(brand, value(theme, "--foreground"), 0.88))).toBeGreaterThanOrEqual(AA);
    });

    test("white text on the brand fails AA, so the brand foreground is the dark zinc", () => {
      expect(contrast("#ffffff", brand)).toBeLessThan(AA);
      expect(luminance(parseColor(value(theme, "--brand-foreground")))).toBeLessThan(0.01);
    });

    test.each([...SURFACES, "--brand-subtle"])("brand-text is AA on %s", (surface) => {
      expect(contrast(value(theme, "--brand-text"), value(theme, surface), bg)).toBeGreaterThanOrEqual(AA);
    });

    test("foreground and muted-foreground are AA on brand-subtle", () => {
      const subtle = value(theme, "--brand-subtle");
      expect(contrast(value(theme, "--foreground"), subtle)).toBeGreaterThanOrEqual(AA);
      expect(contrast(value(theme, "--muted-foreground"), subtle)).toBeGreaterThanOrEqual(AA);
    });

    test.each(SURFACES)("the brand button's edge is 3:1 against %s (the fill, or its 1px ring)", (name) => {
      const surface = value(theme, name);
      const ring = value(theme, "--brand-ring");
      if (contrast(brand, surface) >= NON_TEXT) return;
      // The fill alone is too close to the surface (light theme): the ring must hold the edge on both sides.
      expect(contrast(ring, surface), "ring vs surface").toBeGreaterThanOrEqual(NON_TEXT);
      expect(contrast(ring, brand), "ring vs fill").toBeGreaterThanOrEqual(NON_TEXT);
    });

    test("the focus ring is too close to the brand fill to sit on it, so it needs the offset", () => {
      // Documents why the brand variant (like every variant) draws the ring at a 2px offset.
      expect(contrast(value(theme, "--ring"), brand)).toBeLessThan(NON_TEXT);
      expect(contrast(value(theme, "--ring"), bg)).toBeGreaterThanOrEqual(NON_TEXT);
    });

    test.each([...ACCENTS.map((a) => `--channel-${a}`), ...CHATS, ...CHARTS, ...STATUS_TONES, "--live"])(
      "%s is never mistaken for the brand (OKLab dE >= 0.07)",
      (name) => {
        expect(deltaE(value(theme, name), brand)).toBeGreaterThanOrEqual(BRAND_DISTANCE);
      },
    );
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
    ring: ["--background", "--surface-sunken", "--card", "--surface-raised", "--popover", "--muted"],
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

describe("surfaces", () => {
  const L = (theme: Map<string, string>, name: string): number => luminance(parseColor(value(theme, name)));

  test("dark steps up with a lighter fill: page < sunken < card < raised, and popovers are raised", () => {
    expect(L(dark, "--background")).toBeLessThan(L(dark, "--surface-sunken"));
    expect(L(dark, "--surface-sunken")).toBeLessThan(L(dark, "--card"));
    expect(L(dark, "--card")).toBeLessThan(L(dark, "--surface-raised"));
    expect(value(dark, "--popover")).toBe(value(dark, "--surface-raised"));
    expect(value(dark, "--sidebar")).toBe(value(dark, "--surface-sunken"));
  });

  test("dark raised surfaces cast no shadow; light ones do", () => {
    expect(raw(dark, "--surface-raised-shadow")).toBe("0 0 #0000");
    expect(raw(light, "--surface-raised-shadow")).toMatch(/^0 1px 2px oklch\(.+\), 0 4px 12px oklch\(.+\)$/);
  });

  test("light steps up with a shadow: card and raised are the page white, sunken is zinc-50", () => {
    expect(value(light, "--card")).toBe(value(light, "--background"));
    expect(value(light, "--surface-raised")).toBe(value(light, "--background"));
    expect(L(light, "--surface-sunken")).toBeLessThan(L(light, "--background"));
    expect(value(light, "--popover")).toBe(value(light, "--surface-raised"));
  });

  test("the scrim behind dialogs is a theme-independent translucent black", () => {
    expect(independent.get("--scrim")).toBe("oklch(0 0 0 / 60%)");
    expect(lightOwn.has("--scrim")).toBe(false);
    expect(darkOwn.has("--scrim")).toBe(false);
  });
});

/** Splits `a:b-[x:y]:ring-2` into its variant prefix (`a:b-[x:y]:`) and utility (`ring-2`). */
function splitVariant(cls: string): [string, string] {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === "[") depth++;
    else if (cls[i] === "]") depth--;
    else if (cls[i] === ":" && depth === 0) cut = i + 1;
  }
  return [cls.slice(0, cut), cls.slice(cut)];
}

const componentsDir = join(import.meta.dirname, "../src/components");
const componentFiles = readdirSync(componentsDir)
  .filter((f) => f.endsWith(".tsx"))
  .map((file) => ({ file, classes: readFileSync(join(componentsDir, file), "utf8").split(/[\s"'`]+/) }));

/**
 * Every focus-indicator ring color in src/components: utilities like
 * `focus-visible:ring-ring`, `focus-within:ring-ring`,
 * `has-[…:focus-visible]:ring-ring`, `group-focus-visible/x:ring-…`.
 */
function componentRings(): [string, string][] {
  const out: [string, string][] = [];
  for (const { file, classes } of componentFiles) {
    const text = classes.join(" ");
    const seen = new Set<string>();
    for (const cls of classes) {
      if (!cls.includes("focus")) continue;
      const m = /:ring-([a-z][a-z-]*(?:\/\d+)?)$/.exec(cls);
      if (!m || /^(offset|inset)/.test(m[1]!)) continue;
      seen.add(m[1]!);
    }
    // Slider thumbs and sidebar buttons set the ring color unprefixed (`ring-sidebar-ring … focus-visible:ring-2`).
    if (file === "slider.tsx" || file === "sidebar.tsx") {
      for (const m of ` ${text} `.matchAll(/\sring-([a-z][a-z-]*(?:\/\d+)?)(?=\s)/g)) {
        if (!/^(offset|inset)/.test(m[1]!)) seen.add(m[1]!);
      }
    }
    for (const token of seen) out.push([file, token]);
  }
  return out;
}

/** Focus-ring widths per variant prefix in a component: `focus-visible:` → `2`. */
function focusWidths(classes: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const cls of classes) {
    if (!cls.includes("focus")) continue;
    const [prefix, utility] = splitVariant(cls);
    if (!prefix.includes("focus")) continue;
    const m = /^ring-(\d+|\[[^\]]+\])$/.exec(utility);
    if (m) out.push([prefix, m[1]!]);
  }
  return out;
}

/** The scroll-area viewport is a scroll container inside clipping parents: its ring is drawn inset instead. */
const INSET_FOCUS = new Set(["scroll-area.tsx"]);

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

  test("no primitive keeps a thin or custom-width focus ring (ring-1, ring-3, ring-[3px])", () => {
    const offenders = componentFiles.flatMap(({ file, classes }) =>
      focusWidths(classes)
        .filter(([, width]) => width !== "2" && width !== "0")
        .map(([prefix, width]) => `${file}: ${prefix}ring-${width}`),
    );
    expect(offenders).toEqual([]);
  });

  test.each(componentFiles.map((f) => [f.file, f.classes] as const))(
    "%s: one focus rule, ring-2 at a 2px offset in the surface color",
    (file, classes) => {
      const required = focusWidths(classes).flatMap(([prefix, width]): string[][] => {
        // A reset (any focus variant, plain `focus:` included) must drop the offset too, or a
        // 2px halo in the offset color stays behind.
        if (width === "0") return [[`${prefix}ring-offset-0`]];
        if (INSET_FOCUS.has(file)) return [[`${prefix}ring-inset`]];
        return [[`${prefix}ring-offset-2`], [`${prefix}ring-offset-background`, `${prefix}ring-offset-sidebar`]];
      });
      const missing = required.filter((anyOf) => !anyOf.some((cls) => classes.includes(cls))).map((a) => a[0]);
      expect(missing).toEqual([]);
    },
  );

  test.each(BUTTON_VARIANTS)("button %s: ring at a 2px offset, and the grey never recolors the border", (variant) => {
    const classes = cn(buttonVariants({ variant })).split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "focus-visible:ring-2",
        "focus-visible:ring-offset-2",
        "focus-visible:ring-offset-background",
      ]),
    );
    expect(classes).not.toContain("focus-visible:border-ring");
  });
});

describe("theme structure", () => {
  test("every accent has a [data-accent] rule mapping to its tokens", () => {
    for (const accent of ACCENTS) {
      const rule = accent === "zinc" ? `:root,\n[data-accent="zinc"]` : `[data-accent="${accent}"]`;
      const vars = parse(block(css, rule));
      expect(vars.get("--channel-accent")).toBe(`var(--channel-${accent})`);
      expect(vars.get("--channel-accent-foreground")).toBe(`var(--channel-${accent}-foreground)`);
    }
  });

  test("the light theme is written once (no hand-copied .light or [data-theme=system] blocks)", () => {
    expect(css.match(/^\s*@variant light-theme \{/gm)).toHaveLength(1);
    expect(css).not.toMatch(/^\.light,/m);
    expect(css).not.toMatch(/^\s*\[data-theme="system"\] \{/m);
  });

  test("the light theme overrides every color the dark theme defines", () => {
    const missing = [...darkOwn.keys()].filter((k) => !lightOwn.has(k));
    expect(missing).toEqual([]);
    expect([...lightOwn.keys()].filter((k) => !darkOwn.has(k))).toEqual([]);
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
      "--surface-sunken",
      "--surface-raised",
      "--scrim",
      "--brand",
      "--brand-foreground",
      "--brand-text",
      "--brand-subtle",
      "--brand-ring",
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

  test("corners are square: --radius is 0 and theme-independent", () => {
    expect(independent.get("--radius")).toBe("0");
    expect(darkOwn.has("--radius")).toBe(false);
    expect(lightOwn.has("--radius")).toBe(false);
  });

  test("motion tokens: 120 / 200 / 320 ms", () => {
    expect(independent.get("--duration-fast")).toBe("120ms");
    expect(independent.get("--duration-base")).toBe("200ms");
    expect(independent.get("--duration-slow")).toBe("320ms");
  });

  test("reduced motion disables animations and transitions and makes every motion token instant", () => {
    const reduced = block(css, "@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms !important/);
    expect(reduced).toMatch(/transition-duration:\s*0\.01ms !important/);
    const tokens = parse(block(reduced, ":root"));
    for (const name of ["--duration-fast", "--duration-base", "--duration-slow"]) {
      expect(tokens.get(name), name).toBe("0.01ms");
    }
  });
});

/** Utilities the new tokens must generate, by the declaration they compile to. */
const UTILITIES: Record<string, RegExp> = {
  "bg-brand": /background-color: var\(--brand\)/,
  "text-brand-foreground": /color: var\(--brand-foreground\)/,
  "text-brand-text": /color: var\(--brand-text\)/,
  "bg-brand-subtle": /background-color: var\(--brand-subtle\)/,
  "border-brand-ring": /border-color: var\(--brand-ring\)/,
  "bg-brand-hover": /color-mix\(in oklab, var\(--brand\) 88%, var\(--foreground\)\)/,
  "bg-surface-sunken": /background-color: var\(--surface-sunken\)/,
  "bg-surface-raised": /background-color: var\(--surface-raised\)/,
  "bg-scrim": /background-color: var\(--scrim\)/,
  "shadow-raised": /--tw-shadow: var\(--surface-raised-shadow\)/,
  "duration-fast": /transition-duration: var\(--duration-fast\)/,
  "duration-base": /transition-duration: var\(--duration-base\)/,
  "duration-slow": /transition-duration: var\(--duration-slow\)/,
  "ease-out": /transition-timing-function: var\(--ease-out\)/,
  "ease-in-out": /transition-timing-function: var\(--ease-in-out\)/,
  "max-w-page": /max-width: var\(--container-page\)/,
  "max-w-board": /max-width: var\(--container-board\)/,
  "max-w-form-page": /max-width: var\(--container-form-page\)/,
  "max-w-form": /max-width: var\(--container-form\)/,
  "max-w-reading": /max-width: var\(--container-reading\)/,
  "text-display": /font-size: var\(--text-display\)/,
  "rounded-xs": /border-radius: calc\(var\(--radius\) \* 0\.4\)/,
  "rounded-sm": /border-radius: calc\(var\(--radius\) \* 0\.6\)/,
  "rounded-md": /border-radius: calc\(var\(--radius\) \* 0\.8\)/,
  "rounded-lg": /border-radius: var\(--radius\)/,
  "rounded-4xl": /border-radius: calc\(var\(--radius\) \* 2\.6\)/,
};

const compiled = await compileGlobals(Object.keys(UTILITIES));

describe("compiled CSS (Tailwind)", () => {
  test("the light block is emitted for the explicit choice and for system on a light OS, after the dark tokens", () => {
    const explicit = parse(block(compiled, ':is(.light, [data-theme="light"])'));
    const media = block(compiled, "@media (prefers-color-scheme: light)");
    const system = parse(block(media, ':is([data-theme="system"])'));
    expect(Object.fromEntries(explicit)).toEqual(Object.fromEntries(lightOwn));
    expect(Object.fromEntries(system)).toEqual(Object.fromEntries(lightOwn));
    expect(compiled.indexOf(":root, .dark {")).toBeGreaterThan(-1);
    expect(compiled.indexOf(':is(.light, [data-theme="light"])')).toBeGreaterThan(compiled.indexOf(":root, .dark {"));
  });

  test.each(Object.entries(UTILITIES))("%s compiles from the tokens", (utility, declaration) => {
    const rule = block(compiled, `.${utility.replace(/[.:/[\]]/g, (c) => `\\${c}`)}`);
    expect(rule).toMatch(declaration);
  });

  test("the theme pins the easing curves and page widths, and transitions default to the fast token", () => {
    expect(css).toContain("--ease-out: cubic-bezier(0.2, 0, 0, 1);");
    expect(css).toContain("--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);");
    expect(css).toContain("--default-transition-duration: var(--duration-fast);");
    for (const [name, width] of [
      ["page", "100rem"],
      ["board", "100rem"],
      ["form-page", "70rem"],
      ["form", "48rem"],
      ["reading", "40rem"],
    ]) {
      expect(compiled).toContain(`--container-${name}: ${width};`);
    }
  });
});
