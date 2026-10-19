// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Source policy for everything above the shadcn layer (house primitives, layouts, blocks and
 * stories): no raw interactive HTML, no arbitrary Tailwind values, no color literals, no direct
 * Base UI or sonner imports, no native `title=` tooltips and no inline `style`. The shadcn layer
 * (`src/components/**`, `src/hooks/**`, `src/styles/shadcn.css`) and `src/toast.tsx` are exempt.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { nativeTitleAttributes } from "./guards.test.ts";

const pkgRoot = join(import.meta.dirname, "..");

export type Rule = "raw-element" | "role-on-div" | "arbitrary-value" | "color-literal" | "import" | "native-title" | "style";

export interface Violation {
  rule: Rule;
  line: number;
  match: string;
}

/** Blanks comments (keeping newlines) so prose such as "no `<button>`" is not flagged. */
export function stripComments(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[\s;{}(])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function collect(text: string, rule: Rule, re: RegExp, keep: (m: RegExpMatchArray) => boolean = () => true): Violation[] {
  return [...text.matchAll(re)].filter(keep).map((m) => ({ rule, line: lineOf(text, m.index ?? 0), match: m[0] }));
}

/** `<button`, `<input`, `<select`, `<textarea`, `<table`, `<dialog` as JSX intrinsic elements. */
export function rawElements(text: string): Violation[] {
  return collect(text, "raw-element", /<(?:button|input|select|textarea|table|dialog)(?=[\s/>])/g);
}

/** `role=` on a `<div>` or `<span>` (use the semantic element or the shadcn component). */
export function rolesOnGenericElements(text: string): Violation[] {
  return collect(text, "role-on-div", /<(?:div|span)\b(?:[^<>]|=>)*?\srole=/g);
}

/**
 * Arbitrary values: `w-[…]`, `md:grid-cols-[…]`, the v4 variable shorthand `bg-(--x)` and arbitrary
 * properties `[--x:…]`. Arbitrary *variants* (`data-[state=open]:`, `group-data-[size=sm]/item:`)
 * are selectors, not values, and are not flagged.
 */
export function arbitraryValues(text: string): Violation[] {
  const isVariant = (m: RegExpMatchArray): boolean => {
    const next = text[(m.index ?? 0) + m[0].length] ?? "";
    return next === ":" || next === "/";
  };
  return [
    ...collect(text, "arbitrary-value", /(?<![\w-])(?:[a-z0-9-]+:)*!?-?[a-z][a-z0-9-]*-\[[^\]\s"'`]+\]/g, (m) => !isVariant(m)),
    ...collect(text, "arbitrary-value", /(?<![\w-])(?:[a-z0-9-]+:)*!?-?[a-z][a-z0-9-]*-\(--[\w-]+\)/g, (m) => !isVariant(m)),
    ...collect(text, "arbitrary-value", /\[--[\w-]+:[^\]\s"'`]+\]/g),
  ].sort((a, b) => a.line - b.line);
}

/** Hex colors and color functions; tokens live in `src/styles/globals.css` only. */
export function colorLiterals(text: string): Violation[] {
  return [
    ...collect(text, "color-literal", /(?<=["'`\s(:,])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g),
    ...collect(text, "color-literal", /(?<![\w-])(?:rgba?|hsla?|oklch|oklab|color-mix)\(/g),
  ].sort((a, b) => a.line - b.line);
}

/** Direct imports of Base UI or sonner (go through `src/components` and `src/toast.tsx`). */
export function forbiddenImports(text: string): Violation[] {
  return collect(text, "import", /(?:from\s+|import\s*\(\s*|import\s+)["'](?:@base-ui\/react|sonner)(?:\/[^"']*)?["']/g);
}

/** Native `title=` tooltips on lower-case JSX elements (detector shared with `guards.test.ts`). */
export function nativeTitles(text: string): Violation[] {
  const out: Violation[] = [];
  let seen = 0;
  for (const m of text.matchAll(/\btitle=/g)) {
    const end = (m.index ?? 0) + m[0].length;
    const hits = nativeTitleAttributes(text.slice(0, end));
    if (hits.length > seen) out.push({ rule: "native-title", line: lineOf(text, m.index ?? 0), match: `<${hits.at(-1)} title=` });
    seen = hits.length;
  }
  return out;
}

/** Inline `style` props: dynamic geometry goes through a component prop instead. */
export function inlineStyles(text: string): Violation[] {
  return collect(text, "style", /(?<=\s)style=\{?/g);
}

export function scan(source: string): Violation[] {
  const text = stripComments(source);
  return [
    ...rawElements(text),
    ...rolesOnGenericElements(text),
    ...arbitraryValues(text),
    ...colorLiterals(text),
    ...forbiddenImports(text),
    ...nativeTitles(text),
    ...inlineStyles(text),
  ];
}

interface AllowEntry {
  file: string;
  rule: Rule;
  reason: string;
}

/**
 * Every exception, with its reason. `contract request` entries are real violations in U1–U5 code
 * this unit does not own; the head agent fixes them and then deletes the entry (a stale entry
 * fails the "allowlist is current" test below).
 */
const ALLOW: AllowEntry[] = [];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "storybook-static") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(entry)) out.push(full);
  }
  return out;
}

const EXEMPT = /^src\/(components|hooks)\/|^src\/toast\.tsx$|^src\/styles\/(globals|shadcn)\.css$/;
const files = [...walk(join(pkgRoot, "src")), ...walk(join(pkgRoot, "stories"))]
  .map((file) => relative(pkgRoot, file))
  .filter((file) => !EXEMPT.test(file))
  .map((file) => ({ file, violations: scan(readFileSync(join(pkgRoot, file), "utf8")) }));

const allowed = (file: string, rule: Rule): boolean => ALLOW.some((entry) => entry.file === file && entry.rule === rule);

describe("detectors", () => {
  test("raw interactive elements", () => {
    expect(rawElements(`<button onClick={go}>x</button>`).map((v) => v.match)).toEqual(["<button"]);
    expect(rawElements(`<input />\n<select>\n<textarea\n  id="a">\n<table>\n<dialog open>`).map((v) => v.line)).toEqual([
      1, 2, 3, 5, 6,
    ]);
    expect(rawElements(`<Button>x</Button> <InputGroupInput /> <Table> <SelectTrigger> <buttonish>`)).toEqual([]);
  });

  test("role on div and span", () => {
    expect(rolesOnGenericElements(`<div className="x" role="group">`)).toHaveLength(1);
    expect(rolesOnGenericElements(`<span\n  onClick={() => go()}\n  role="img">`)).toHaveLength(1);
    expect(rolesOnGenericElements(`<section role="region"> <div className="x"> <ChartContainer role="img">`)).toEqual([]);
  });

  test("arbitrary values, variable shorthands and properties", () => {
    const hits = (s: string): string[] => arbitraryValues(s).map((v) => v.match);
    expect(hits(`className="w-[12px] p-4"`)).toEqual(["w-[12px]"]);
    expect(hits(`className="md:grid-cols-[1fr_auto] hover:bg-[color]"`)).toEqual(["md:grid-cols-[1fr_auto]", "hover:bg-[color]"]);
    expect(hits(`className="bg-(--segment) gap-(--card-spacing)"`)).toEqual(["bg-(--segment)", "gap-(--card-spacing)"]);
    expect(hits(`className="[--card-spacing:--spacing(4)]"`)).toEqual(["[--card-spacing:--spacing(4)]"]);
    expect(hits(`className="data-[state=open]:flex group-data-[size=sm]/item:gap-2 grid-cols-3 items[0]"`)).toEqual([]);
  });

  test("color literals", () => {
    const hits = (s: string): string[] => colorLiterals(s).map((v) => v.match);
    expect(hits(`fill="#fff" stroke='#a1b2c3' x=" #a1b2c3d4"`)).toEqual(["#fff", "#a1b2c3", "#a1b2c3d4"]);
    expect(hits(`c: rgb(0 0 0), rgba(0,0,0,1) hsl(1 2% 3%) oklch(1 0 0) oklab(1 0 0) color-mix(in oklch, a, b)`)).toHaveLength(6);
    expect(hits(`href="#main-content" href="#settings" var(--chart-1) fill="var(--x)" useHslMode()`)).toEqual([]);
  });

  test("Base UI and sonner imports", () => {
    expect(forbiddenImports(`import { useRender } from "@base-ui/react/use-render";`)).toHaveLength(1);
    expect(forbiddenImports(`import { toast } from 'sonner';\nconst m = import("sonner");`)).toHaveLength(2);
    expect(forbiddenImports(`import { toast } from "@commonair/ui/toast";`)).toEqual([]);
  });

  test("native titles reuse the guards detector and report lines", () => {
    expect(nativeTitles(`<EmptyState title="ok" />\n<span\n  title="nope">`)).toEqual([
      { rule: "native-title", line: 3, match: "<span title=" },
    ]);
    expect(nativeTitles(`<CardTitle>x</CardTitle> <PageHeader title={t("a")} />`)).toEqual([]);
  });

  test("inline styles", () => {
    expect(inlineStyles(`<div style={{ width: 4 }}>`).map((v) => v.match)).toEqual(["style={"]);
    expect(inlineStyles(`<div\n  style="color: red">`)).toHaveLength(1);
    expect(inlineStyles(`const style = {}; buttonStyle={x} data-style="y"`)).toEqual([]);
  });

  test("comments are ignored but URLs inside strings are kept", () => {
    expect(scan(`// no <button> here\n/* or <input> */\nconst a = "x";`)).toEqual([]);
    expect(stripComments(`const u = "https://example.org";`)).toBe(`const u = "https://example.org";`);
  });
});

describe("source policy", () => {
  test.each(files.map((f) => [f.file, f.violations] as const))("%s follows the source policy", (file, violations) => {
    const offending = violations
      .filter((v) => !allowed(file, v.rule))
      .map((v) => `${file}:${v.line} ${v.rule} ${v.match}`);
    expect(offending).toEqual([]);
  });

  test("every allowlist entry still matches a violation", () => {
    const stale = ALLOW.filter(
      (entry) => !files.some((f) => f.file === entry.file && f.violations.some((v) => v.rule === entry.rule)),
    ).map((entry) => `${entry.file} ${entry.rule}`);
    expect(stale).toEqual([]);
  });
});
