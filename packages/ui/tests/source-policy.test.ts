// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Source policy for everything above the shadcn layer (house primitives, layouts, blocks and
 * stories): no raw interactive HTML, no `role=` on div/span, no arbitrary Tailwind values, no
 * color literals, no direct Base UI or sonner imports, no native `title=` tooltips and no inline
 * `style`. The shadcn layer (`src/components/**`, `src/hooks/**`, `src/styles/*.css`) and
 * `src/toast.tsx` are exempt. Mirrors `apps/web/tests/source-policy.test.ts`: string-aware comment
 * stripping, JSX opening-tag scanning, and an allowlist keyed by file + rule + snippet with an
 * exact count (extra occurrences and unused entries fail).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { nativeTitleAttributes } from "./guards.test.ts";

const pkgRoot = join(import.meta.dirname, "..");

export type Rule =
  | "raw-element"
  | "role-on-div"
  | "arbitrary-value"
  | "color-literal"
  | "import"
  | "native-title"
  | "style";

export interface Violation {
  rule: Rule;
  line: number;
  snippet: string;
}

/**
 * Blank comments (and with `blankStrings`, string and template text too), keeping line breaks so
 * line numbers survive. String-aware: `//` inside a string is not a comment; template `${…}`
 * expressions stay code.
 */
export function lex(text: string, { blankStrings = false } = {}): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  let out = "";
  const modes: ("code" | "template")[] = ["code"];
  const depths: number[] = [0];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (modes[modes.length - 1] === "template") {
      if (ch === "\\") {
        out += blankStrings ? "  " : ch + next;
        i += 2;
      } else if (ch === "`") {
        out += ch;
        modes.pop();
        i++;
      } else if (ch === "$" && next === "{") {
        out += "${";
        modes.push("code");
        depths.push(0);
        i += 2;
      } else {
        out += blankStrings && ch !== "\n" ? " " : ch;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const closed = text[j] === ch;
      const stop = closed ? j + 1 : j;
      out += blankStrings ? ch + blank(text.slice(i + 1, j)) + (closed ? ch : "") : text.slice(i, stop);
      i = stop;
    } else if (ch === "`") {
      out += ch;
      modes.push("template");
      i++;
    } else {
      const top = depths.length - 1;
      if (ch === "{") depths[top] = (depths[top] ?? 0) + 1;
      else if (ch === "}") {
        if ((depths[top] ?? 0) === 0 && modes.length > 1) {
          modes.pop();
          depths.pop();
        } else depths[top] = (depths[top] ?? 0) - 1;
      }
      out += ch;
      i++;
    }
  }
  return out;
}

export const stripComments = (text: string): string => lex(text);

interface OpeningTag {
  name: string;
  attrs: string;
  index: number;
}

/** JSX opening tags in string-blanked code; `<` right after an identifier, `)` or `]` is a generic. */
export function openingTags(code: string): OpeningTag[] {
  const tags: OpeningTag[] = [];
  const start = /<([A-Za-z][\w.-]*)/g;
  for (let m = start.exec(code); m; m = start.exec(code)) {
    const prev = m.index > 0 ? (code[m.index - 1] ?? "") : "";
    if (/[\w$)\].]/.test(prev)) continue;
    let depth = 0;
    let i = start.lastIndex;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0 && code[i - 1] !== "=") break;
    }
    tags.push({ name: m[1] ?? "", attrs: code.slice(start.lastIndex, i), index: m.index });
  }
  return tags;
}

function stringLiterals(text: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ value: m[0].slice(1, -1), index: m.index + 1 });
  return out;
}

/**
 * Tailwind arbitrary syntax in a class token: values (`w-[3px]`, `md:grid-cols-[…]`), properties
 * (`[--x:…]`), the v4 variable shorthand (`bg-(--x)`), arbitrary selector variants (`[&_svg]:…`)
 * and arbitrary breakpoints (`min-[420px]:…`). State variants on data/aria attributes
 * (`data-[state=open]:`, `group-data-[size=sm]/item:`) are selectors, not values, and are allowed.
 */
export function isArbitraryClass(token: string): boolean {
  const parts = token.split(/:(?![^[]*\])/);
  const utility = parts.pop() ?? "";
  const variantHit = parts.some((variant) => variant.startsWith("[&") || /^(?:min|max)-\[/.test(variant));
  const utilityHit =
    /-\[[^\]\s]+\]/.test(utility) ||
    /^!?\[[a-z-]+:[^\]\s]+\]$/.test(utility) ||
    /-\((?:[a-z-]+:)?--[\w-]+\)/.test(utility);
  return variantHit || utilityHit;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;
const HEX = /(?<![\w/&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN = /(?<![\w-])(?:rgba?|hsla?|oklch|oklab|color-mix)\(/g;

export function scan(source: string, file = "x.tsx"): Violation[] {
  const text = lex(source);
  const out: Violation[] = [];
  const add = (rule: Rule, index: number, snippet: string): void => {
    out.push({ rule, line: lineOf(text, index), snippet: snippet.trim().slice(0, 80) });
  };
  if (file.endsWith(".tsx"))
    for (const tag of openingTags(lex(source, { blankStrings: true }))) {
      const snippet = `<${tag.name}${tag.attrs.split("\n")[0] ?? ""}`;
      if (/^(?:button|input|select|textarea|table|dialog)$/.test(tag.name)) add("raw-element", tag.index, snippet);
      if ((tag.name === "div" || tag.name === "span") && /(^|\s)role=/.test(tag.attrs))
        add("role-on-div", tag.index, snippet);
      if (nativeTitleAttributes(`<${tag.name}${tag.attrs}`).length > 0) add("native-title", tag.index, snippet);
      if (/(^|\s)style=/.test(tag.attrs)) add("style", tag.index, snippet);
    }
  for (const lit of stringLiterals(text)) {
    for (const token of lit.value.split(/\s+/))
      if (token && isArbitraryClass(token)) add("arbitrary-value", lit.index, token);
    for (const hex of lit.value.matchAll(HEX)) add("color-literal", lit.index + (hex.index ?? 0), hex[0]);
  }
  for (const m of text.matchAll(COLOR_FN)) add("color-literal", m.index ?? 0, m[0]);
  for (const m of text.matchAll(/\b(?:from|import)\s*\(?\s*["'](?:@base-ui\/react(?:\/[^"']*)?|sonner)["']/g))
    add("import", m.index ?? 0, m[0]);
  return out;
}

interface AllowEntry {
  file: string;
  rule: Rule;
  /** Substring of the violation's snippet that identifies the allowed occurrence. */
  match: string;
  /** Exactly this many occurrences are allowed (and expected). */
  count: number;
  reason: string;
}

/**
 * Every exception, with its reason. `contract request` entries are real violations in U1–U5 code
 * this unit does not own: the head agent fixes them and deletes the entry (an unused entry fails).
 */
const ALLOW: AllowEntry[] = [
  {
    file: "src/blocks/data/breakdown.tsx",
    rule: "style",
    match: "<span",
    count: 1,
    reason: "Legend swatch: the segment's chart token is passed as a CSS variable (same as a chart config color).",
  },
  {
    file: "src/blocks/data/breakdown.tsx",
    rule: "arbitrary-value",
    match: "bg-(--segment-color)",
    count: 1,
    reason: "Legend swatch paints the per-segment chart token variable set by the style above.",
  },
  {
    file: "src/blocks/data/key-value-list.tsx",
    rule: "arbitrary-value",
    match: "grid-cols-[minmax(0,1fr)_auto]",
    count: 1,
    reason: "contract request: use a flex row per entry (or a scale grid) instead of an arbitrary template.",
  },
  {
    file: "src/blocks/data/timeline.tsx",
    rule: "arbitrary-value",
    match: "grid-cols-[auto_1fr]",
    count: 2,
    reason: "contract request: use flex rows (marker + content) instead of an arbitrary grid template.",
  },
  {
    file: "src/blocks/data/progress-row.tsx",
    rule: "arbitrary-value",
    match: "[&_[data-slot=progress-indicator]]",
    count: 5,
    reason: "contract request: tone the indicator through a Progress variant/prop, not an arbitrary child selector.",
  },
  {
    file: "src/blocks/data/uptime-strip.tsx",
    rule: "role-on-div",
    match: "<div",
    count: 1,
    reason:
      "contract request: role=img makes its focusable tooltip triggers presentational; use a list/figure with labelled days.",
  },
  {
    file: "src/primitives/overlay-badge.tsx",
    rule: "arbitrary-value",
    match: "[&>svg]",
    count: 1,
    reason:
      "contract request: size the icon through the HugeiconsIcon size/className at the call site, not a child selector.",
  },
  {
    file: "src/primitives/viewer-count.tsx",
    rule: "arbitrary-value",
    match: "[&_svg]",
    count: 2,
    reason:
      "contract request: size the icon through the HugeiconsIcon className per size variant, not a child selector.",
  },
  {
    file: "src/blocks/media/chat.tsx",
    rule: "role-on-div",
    match: "<div",
    count: 1,
    reason: "The chat log needs the ARIA log role (live region); HTML has no log element.",
  },
  {
    file: "src/blocks/media/player-chrome.tsx",
    rule: "arbitrary-value",
    match: "[&>video]",
    count: 2,
    reason: "Sizes the app-supplied <video> child, which the composition cannot style any other way.",
  },
  ...["src/blocks/media/category-tile.tsx", "src/blocks/media/media-card.tsx", "src/primitives/stream-card.tsx"].map(
    (file): AllowEntry => ({
      file,
      rule: "import",
      match: "@base-ui/react/use-render",
      count: 1,
      reason: "useRender gives the tile a router-agnostic link (`render`), as the shadcn parts do.",
    }),
  ),
  {
    file: "stories/fixtures.ts",
    rule: "color-literal",
    match: "hsl(",
    count: 6,
    reason: "Inline SVG data-URI story images (thumbnails, avatars): image content, not UI color.",
  },
  {
    file: "stories/Formatting.stories.tsx",
    rule: "raw-element",
    match: "<table",
    count: 1,
    reason: "contract request: render the formatting samples with Table (or DataTable).",
  },
  {
    file: "stories/StreamCard.stories.tsx",
    rule: "arbitrary-value",
    match: "grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]",
    count: 2,
    reason: "contract request: use StreamGrid or scale grid columns.",
  },
  {
    file: "stories/ThemeAndShortcuts.stories.tsx",
    rule: "arbitrary-value",
    match: "grid-cols-[auto_auto_auto]",
    count: 1,
    reason: "contract request: use grid-cols-3 or flex rows.",
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "storybook-static") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const EXEMPT = /^src\/(components|hooks)\/|^src\/toast\.tsx$/;
const files = [...walk(join(pkgRoot, "src")), ...walk(join(pkgRoot, "stories"))]
  .map((file) => relative(pkgRoot, file))
  .filter((file) => !EXEMPT.test(file));
const all = files.flatMap((file) =>
  scan(readFileSync(join(pkgRoot, file), "utf8"), file).map((violation) => ({ file, ...violation })),
);
const entryFor = (v: (typeof all)[number]): AllowEntry | undefined =>
  ALLOW.find((entry) => entry.file === v.file && entry.rule === v.rule && v.snippet.includes(entry.match));

describe("detectors", () => {
  const rules = (source: string, file = "x.tsx"): Rule[] => scan(source, file).map((v) => v.rule);

  test.each([
    ["<button onClick={go}>x</button>", "raw-element"],
    ['<input type="text" />', "raw-element"],
    ["<select>", "raw-element"],
    ["<textarea />", "raw-element"],
    ["<table>", "raw-element"],
    ["<dialog open>", "raw-element"],
    ['<div className="x" role="group">', "role-on-div"],
    ['<span\n  onClick={() => go()}\n  role="img">', "role-on-div"],
    ['<div className="w-[12px] p-4" />', "arbitrary-value"],
    ['<div className="md:grid-cols-[1fr_auto]" />', "arbitrary-value"],
    ['<div className="bg-(--segment) p-2" />', "arbitrary-value"],
    ['<div className="[--card-spacing:--spacing(4)]" />', "arbitrary-value"],
    ['<div className="[&_svg]:size-4" />', "arbitrary-value"],
    ['<div className="min-[420px]:grid-cols-3" />', "arbitrary-value"],
    ["const c = cn(open && `w-[12rem]`);", "arbitrary-value"],
    ['const c = "#a1b2c3";', "color-literal"],
    ['<path fill="#fff" />', "color-literal"],
    ['const c = "rgb(0 0 0)";', "color-literal"],
    ['const c = "hsl(1 2% 3%)";', "color-literal"],
    ['const c = "oklch(1 0 0)";', "color-literal"],
    ['const c = "color-mix(in oklch, a, b)";', "color-literal"],
    ['import { useRender } from "@base-ui/react/use-render";', "import"],
    ["import { toast } from 'sonner';", "import"],
    ['const m = import("sonner");', "import"],
    ['<span className="x" title="nope">', "native-title"],
    ['<a onClick={() => go()} title={t("a")}>', "native-title"],
    ["<div style={{ width: 4 }}>", "style"],
    ['<div\n  style="color: red">', "style"],
    ['const u = "a // b"; <button />', "raw-element"],
  ] as const)("flags %s as %s", (source, rule) => {
    expect(rules(source)).toContain(rule);
  });

  test.each([
    "<Button onClick={go}>x</Button>",
    "<InputGroupInput /> <Table> <SelectTrigger> <buttonish>",
    '<section role="region"> <ChartContainer role="img">',
    '<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:w-56" />',
    '<div className="data-[state=open]:flex group-data-[size=sm]/item:gap-2" />',
    '<EmptyState icon={X} title="ok" /> <PageHeader title={t("a")} />',
    'const link = "#main-content"; const s = "#settings";',
    'const v = "var(--chart-1)";',
    "const xs = new Map<string, number>(); if (a<b && c > d) go();",
    'import { toast } from "@commonair/ui/toast";',
    "// <button> in a comment, rgb( too",
    '/* <div role="x"> style={{}} */',
    "{/* <table> */}",
    'const s = "<button> in a string";',
    "const style = {}; buttonStyle={x}",
  ])("does not flag %s", (source) => {
    expect(rules(source)).toEqual([]);
  });

  test("reports the line of the offending tag", () => {
    const [violation] = scan('const a = 1;\n\nconst b = <div\n  role="button"\n/>;');
    expect(violation).toMatchObject({ rule: "role-on-div", line: 3 });
  });

  test("JSX rules apply to .tsx files only", () => {
    expect(rules("const s = 1; <button />", "x.ts")).toEqual([]);
  });

  test("strips comments, string-aware, keeping line numbers", () => {
    const stripped = stripComments('a /* x\ny */ b\n// c\nd "e // f" `g /* h */ ${i /* j */}`');
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).not.toMatch(/[xycj]/);
    expect(stripped).toContain('"e // f"');
    expect(stripped).toContain("`g /* h */ ${i ");
  });

  test("recognizes arbitrary syntax but not state variants", () => {
    expect(isArbitraryClass("w-[3px]")).toBe(true);
    expect(isArbitraryClass("hover:[&_a]:underline")).toBe(true);
    expect(isArbitraryClass("fill-(--chart-1)")).toBe(true);
    expect(isArbitraryClass("data-[state=open]:bg-muted")).toBe(false);
    expect(isArbitraryClass("w-64")).toBe(false);
    expect(isArbitraryClass("bg-destructive/10")).toBe(false);
  });
});

describe("packages/ui source policy", () => {
  test("scans primitives, layouts, blocks and stories, not the shadcn layer", () => {
    expect(files).toContain("src/primitives/stream-card.tsx");
    expect(files).toContain("stories/pages/Main.stories.tsx");
    expect(files.some((file) => file.startsWith("src/components/"))).toBe(false);
    expect(files).not.toContain("src/toast.tsx");
  });

  test("has no violations outside the allowlist", () => {
    const report = all.filter((v) => !entryFor(v)).map((v) => `${v.file}:${v.line} ${v.rule}: ${v.snippet}`);
    expect(report).toEqual([]);
  });

  test.each(ALLOW)("allowlist: $file ($rule, $match) occurs exactly $count time(s)", (entry) => {
    expect(existsSync(join(pkgRoot, entry.file))).toBe(true);
    expect(entry.reason.length).toBeGreaterThan(20);
    expect(all.filter((v) => entryFor(v) === entry).map((v) => `${v.file}:${v.line}`)).toHaveLength(entry.count);
  });
});
