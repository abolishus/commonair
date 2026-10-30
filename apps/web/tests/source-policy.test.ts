// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * apps/web composes `@commonair/ui`; it never builds its own controls or styling (AGENTS.md "Design
 * rules (web)", E4a). This scans `src/**` (`.ts`, `.tsx` and `.css`; not the generated route tree
 * or `src/server/**`) and fails, with file and line, on: raw interactive HTML, `role=` on div/span,
 * arbitrary Tailwind values/properties/variants/shorthands, color literals, imports that bypass a
 * house primitive (or `buttonVariants` strings instead of `Button render`), native `title=`
 * tooltips, `style=`, `alert/confirm/prompt`, inline number formatting, and raw media or custom
 * elements. One-off exceptions go in ALLOWLIST, keyed by a snippet with an exact count and a
 * reason; extra occurrences and unused entries fail too.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const WEB = new URL("../", import.meta.url).pathname;
const SRC = join(WEB, "src");

export type Rule =
  | "raw-interactive-element"
  | "role-on-div-span"
  | "arbitrary-value"
  | "color-literal"
  | "banned-import"
  | "class-recipe"
  | "native-title"
  | "inline-style"
  | "native-dialog-fn"
  | "inline-format"
  | "raw-media-element"
  | "custom-element";

export interface Violation {
  file: string;
  line: number;
  rule: Rule;
  snippet: string;
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

const ALLOWLIST: AllowEntry[] = [
  {
    file: "src/pwa/theme.ts",
    rule: "color-literal",
    match: "#09090b",
    count: 1,
    reason: "manifest and theme-color cannot read CSS variables (ADR 0028 decision 7)",
  },
  {
    file: "src/pwa/theme.ts",
    rule: "color-literal",
    match: "#ffffff",
    count: 1,
    reason: "manifest and theme-color cannot read CSS variables (ADR 0028 decision 7)",
  },
  {
    file: "src/player/player.tsx",
    rule: "raw-media-element",
    match: "<video",
    count: 1,
    reason:
      "The live <video> is PlayerChrome's child; hls.js, the heartbeat stats and the harness probe need the element.",
  },
  {
    file: "src/components/altcha-field.tsx",
    rule: "custom-element",
    match: 'createElement("altcha-widget"',
    count: 1,
    reason: "The self-hosted ALTCHA proof-of-work widget is a web component; there is no React or shadcn equivalent.",
  },
  {
    file: "src/lib/relays.ts",
    rule: "inline-format",
    match: "new Intl.NumberFormat",
    count: 1,
    reason: "formatBytes needs Intl unit formatting (kB, MB, …) with the locale; @commonair/ui has no byte formatter.",
  },
];

const RAW_INTERACTIVE = new Set(["button", "input", "select", "textarea", "table", "dialog"]);
const RAW_MEDIA = new Set(["video", "audio", "iframe", "canvas", "object", "embed"]);
/** `@commonair/ui/components/*` modules with a house replacement (AGENTS.md "use X, not Y"). */
const HOUSE_REPLACED = {
  "alert-dialog": "ConfirmDialog",
  avatar: "ChannelAvatar",
  badge: "StatusBadge / LiveBadge / OverlayBadge",
  empty: "EmptyState",
  skeleton: "Skeleton* from @commonair/ui",
  sonner: "toast from @commonair/ui/toast",
  table: "DataTable from @commonair/ui/blocks/data",
  kbd: "Kbd/Shortcut from @commonair/ui",
} as const;

/**
 * Blank out comments (and with `blankStrings`, string and template text too), keeping every line
 * break so line numbers survive. String-aware: `//` or `/*` inside a string is not a comment.
 * Quotes end at the closing quote or the end of the line; template `${…}` expressions stay code.
 */
export function lex(text: string, { blankStrings = false } = {}): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
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

/**
 * JSX opening tags, from text whose strings are blanked. A `<` directly after an identifier, `)`
 * or `]` is a generic or a comparison, not JSX. Attributes run to the first `>` outside braces.
 */
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
      else if (ch === ">" && depth === 0) break;
    }
    tags.push({ name: m[1] ?? "", attrs: code.slice(start.lastIndex, i), index: m.index });
  }
  return tags;
}

/** String and template literal contents (single line for quotes, multi-line for templates). */
function stringLiterals(text: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  const re = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ value: m[0].slice(1, -1), index: m.index + 1 });
  return out;
}

/**
 * Tailwind arbitrary syntax: values (`h-[3px]`), properties (`[mask:x]`), variants (`[&>svg]:x`,
 * `min-[420px]:x`) and v4 CSS-variable shorthands (`bg-(--brand)`, `w-(length:--x)`).
 */
export function isArbitraryClass(token: string): boolean {
  return (
    /-\[[^\]\s]+\]/.test(token) ||
    /(^|:)!?\[[a-z-]+:[^\]\s]+\]/.test(token) ||
    /(^|:)\[&[^\]\s]*\]:/.test(token) ||
    /-\((?:[a-z-]+:)?--[\w-]+\)/.test(token)
  );
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;
const HEX = /(?<![\w/&-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FN = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/g;

function cssViolations(file: string, source: string): Violation[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out: Violation[] = [];
  const add = (rule: Rule, index: number, snippet: string) =>
    out.push({ file, line: lineOf(text, index), rule, snippet: snippet.trim().slice(0, 80) });
  for (const m of text.matchAll(HEX)) add("color-literal", m.index ?? 0, m[0]);
  for (const m of text.matchAll(COLOR_FN)) add("color-literal", m.index ?? 0, m[0]);
  for (const m of text.matchAll(/@apply\s+([^;]+);/g))
    for (const token of (m[1] ?? "").split(/\s+/))
      if (token && isArbitraryClass(token)) add("arbitrary-value", m.index ?? 0, token);
  return out;
}

export function findViolations(file: string, source: string): Violation[] {
  if (file.endsWith(".css")) return cssViolations(file, source);
  const text = lex(source);
  const out: Violation[] = [];
  const add = (rule: Rule, index: number, snippet: string) =>
    out.push({ file, line: lineOf(text, index), rule, snippet: snippet.trim().slice(0, 80) });

  if (file.endsWith(".tsx"))
    for (const tag of openingTags(lex(source, { blankStrings: true }))) {
      const lower = tag.name === tag.name.toLowerCase() && !tag.name.includes(".");
      const snippet = `<${tag.name}${tag.attrs.split("\n")[0] ?? ""}`;
      if (RAW_INTERACTIVE.has(tag.name)) add("raw-interactive-element", tag.index, snippet);
      if (RAW_MEDIA.has(tag.name)) add("raw-media-element", tag.index, snippet);
      if (lower && tag.name.includes("-")) add("custom-element", tag.index, snippet);
      if ((tag.name === "div" || tag.name === "span") && /(^|\s)role=/.test(tag.attrs))
        add("role-on-div-span", tag.index, snippet);
      if (lower && /(^|\s)title=/.test(tag.attrs)) add("native-title", tag.index, snippet);
      if (/(^|\s)style=/.test(tag.attrs)) add("inline-style", tag.index, snippet);
    }

  for (const lit of stringLiterals(text)) {
    for (const token of lit.value.split(/\s+/))
      if (token && isArbitraryClass(token)) add("arbitrary-value", lit.index, token);
    for (const hex of lit.value.matchAll(HEX)) add("color-literal", lit.index + (hex.index ?? 0), hex[0]);
  }

  const patterns: [Rule, RegExp][] = [
    ["color-literal", COLOR_FN],
    ["banned-import", /\b(?:from|import)\s*\(?\s*["'](?:@base-ui\/react(?:\/[^"']*)?|sonner)["']/g],
    [
      "banned-import",
      new RegExp(
        `\\b(?:from|import)\\s*\\(?\\s*["']@commonair/ui/components/(?:${Object.keys(HOUSE_REPLACED).join("|")})["']`,
        "g",
      ),
    ],
    ["class-recipe", /\bbuttonVariants\b/g],
    ["native-dialog-fn", /(?<![\w$.])(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\s*\(/g],
    ["inline-format", /\.toLocaleString\(|\.toFixed\(|\bnew Intl\.\w+/g],
    ["custom-element", /\bcreateElement\(\s*["'][a-z][\w]*-[\w-]*["']/g],
  ];
  for (const [rule, re] of patterns) for (const m of text.matchAll(re)) add(rule, m.index ?? 0, m[0]);
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return full === join(SRC, "server") ? [] : sources(full);
    return /\.(ts|tsx|css)$/.test(name) && name !== "routeTree.gen.ts" ? [full] : [];
  });
}

const entryFor = (v: Violation) =>
  ALLOWLIST.find((a) => a.file === v.file && a.rule === v.rule && v.snippet.includes(a.match));

describe("apps/web source policy", () => {
  const all = sources(SRC).flatMap((full) => findViolations(relative(WEB, full), readFileSync(full, "utf8")));

  it("scans the app, its CSS too (and not the server or the generated route tree)", () => {
    const files = sources(SRC).map((f) => relative(WEB, f));
    expect(files).toContain("src/routes/_app.tsx");
    expect(files).toContain("src/routes/_studio/relays.tsx");
    expect(files).toContain("src/styles.css");
    expect(files.some((f) => f.startsWith("src/server/"))).toBe(false);
    expect(files).not.toContain("src/routeTree.gen.ts");
  });

  it("has no violations outside the allowlist", () => {
    const report = all.filter((v) => !entryFor(v)).map((v) => `${v.file}:${v.line} ${v.rule}: ${v.snippet}`);
    expect(report).toEqual([]);
  });

  it.each(ALLOWLIST)("allowlist: $file ($rule, $match) occurs exactly $count time(s)", (entry) => {
    expect(existsSync(join(WEB, entry.file))).toBe(true);
    expect(entry.reason.length).toBeGreaterThan(20);
    const hits = all.filter((v) => entryFor(v) === entry);
    expect(hits.map((v) => `${v.file}:${v.line}`)).toHaveLength(entry.count);
  });
});

describe("detectors", () => {
  const rules = (source: string, file = "x.tsx") => findViolations(file, source).map((v) => v.rule);

  it.each([
    ["<button onClick={go}>x</button>", "raw-interactive-element"],
    ['<input type="text" />', "raw-interactive-element"],
    ["<select>", "raw-interactive-element"],
    ["<textarea />", "raw-interactive-element"],
    ["<table>", "raw-interactive-element"],
    ["<dialog open>", "raw-interactive-element"],
    ['<div role="button" onClick={go} />', "role-on-div-span"],
    ['<span\n  className="x"\n  role="status"\n>', "role-on-div-span"],
    ['<div className="h-[3px]" />', "arbitrary-value"],
    ['<div className="lg:grid-cols-[minmax(0,1fr)_22rem]" />', "arbitrary-value"],
    ['<div className="min-[420px]:grid-cols-3" />', "arbitrary-value"],
    ['<div className="[mask-type:luminance]" />', "arbitrary-value"],
    ['<div className="[&>svg]:size-4" />', "arbitrary-value"],
    ['<div className="bg-(--brand) p-2" />', "arbitrary-value"],
    ['<div className="md:w-(length:--sidebar)" />', "arbitrary-value"],
    ["const c = cn(open && `w-[12rem]`);", "arbitrary-value"],
    ['<div className="text-[#ff0000]" />', "color-literal"],
    ['const c = "#1a2b3c";', "color-literal"],
    ['const c = "rgb(0 0 0)";', "color-literal"],
    ['const c = "oklch(0.5 0.1 200)";', "color-literal"],
    ['const c = "color-mix(in oklab, red, blue)";', "color-literal"],
    ['import { Toaster } from "sonner";', "banned-import"],
    ['import { Dialog } from "@base-ui/react/dialog";', "banned-import"],
    ['import { AlertDialog } from "@commonair/ui/components/alert-dialog";', "banned-import"],
    ['import { Avatar } from "@commonair/ui/components/avatar";', "banned-import"],
    ['import { Table } from "@commonair/ui/components/table";', "banned-import"],
    ['import { Badge } from "@commonair/ui/components/badge";', "banned-import"],
    ['import { Empty } from "@commonair/ui/components/empty";', "banned-import"],
    ['<Link className={buttonVariants({ size: "sm" })} to="/" />', "class-recipe"],
    ['<span title="Full name">x</span>', "native-title"],
    ["<a title={label} href={u}>x</a>", "native-title"],
    ["<div style={{ width: 3 }} />", "inline-style"],
    ["<Bar style={{ width: `${share}%` }} />", "inline-style"],
    ['if (confirm("Sure?")) go();', "native-dialog-fn"],
    ["window.alert(message);", "native-dialog-fn"],
    ["prompt(question)", "native-dialog-fn"],
    ["const s = count.toLocaleString();", "inline-format"],
    ["const s = share.toFixed(1);", "inline-format"],
    ['const f = new Intl.NumberFormat("en");', "inline-format"],
    ['<video src="x" />', "raw-media-element"],
    ['<iframe src="x" />', "raw-media-element"],
    ["<altcha-widget auto />", "custom-element"],
    ['React.createElement("altcha-widget", props)', "custom-element"],
    ['const u = "a // b"; <button />', "raw-interactive-element"],
    ["const t = `x ${'/*'} y`; <div style={{}} />", "inline-style"],
  ] as const)("flags %s as %s", (source, rule) => {
    expect(rules(source)).toContain(rule);
  });

  it.each([
    "<Button onClick={go}>x</Button>",
    '<Input type="text" />',
    '<p role="alert">x</p>',
    '<div className="grid grid-cols-1 gap-4 sm:grid-cols-2" />',
    '<Field orientation="horizontal" />',
    '<CardTitle title="x" />',
    "const xs = new Map<string, number>();",
    "React.useRef<HTMLVideoElement>(null)",
    "if (a<b && c > d) go();",
    'const link = "#main-content";',
    'const pattern = "[a-z0-9_]{3,25}";',
    "const u = `${base}/blob/HEAD/relay/README.md`;",
    '<ConfirmDialog onConfirm={remove} confirmLabel={t("x")} />',
    'toast.success(t("done"));',
    'import { toast } from "@commonair/ui/toast";',
    'import { Tooltip } from "@commonair/ui/components/tooltip";',
    "// <button> in a comment, rgb( too, and window.confirm(x)",
    '/* <div role="x"> style={{}} */',
    "{/* <table> */}",
    'const url = "https://example.org/#abc";',
    'const s = "<button> in a string";',
    "const n = formatNumber(count, locale);",
    "const d = (cells) => cells.map((c) => c.id);",
  ])("does not flag %s", (source) => {
    expect(rules(source)).toEqual([]);
  });

  it("reports the line of the offending tag", () => {
    const [v] = findViolations("x.tsx", 'const a = 1;\n\nconst b = <div\n  role="button"\n/>;');
    expect(v).toMatchObject({ rule: "role-on-div-span", line: 3 });
  });

  it("leaves JSX rules to .tsx files", () => {
    expect(rules("const s = 1; <button />", "x.ts")).toEqual([]);
  });

  it("strips comments, string-aware, keeping line numbers", () => {
    const stripped = stripComments('a /* x\ny */ b\n// c\nd "e // f" `g /* h */ ${i /* j */}`');
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).not.toMatch(/[xycj]/);
    expect(stripped).toContain('"e // f"');
    expect(stripped).toContain("`g /* h */ ${i ");
  });

  it("blanks strings for the tag scan, keeping template expressions", () => {
    const code = lex('x = "<a>"; y = `<b> ${<c />}`;', { blankStrings: true });
    expect(code).not.toContain("<a>");
    expect(code).not.toContain("<b>");
    expect(code).toContain("<c />");
  });

  it("scans CSS for color literals and arbitrary @apply values", () => {
    expect(rules("a { color: #fff; }", "x.css")).toEqual(["color-literal"]);
    expect(rules("a { color: oklch(0.5 0 0); }", "x.css")).toEqual(["color-literal"]);
    expect(rules("a { @apply h-[3px] p-2; }", "x.css")).toEqual(["arbitrary-value"]);
    expect(rules("/* #fff */ a { color: var(--primary); --x: 0; }", "x.css")).toEqual([]);
  });

  it("recognizes Tailwind arbitrary syntax only", () => {
    expect(isArbitraryClass("w-[3px]")).toBe(true);
    expect(isArbitraryClass("hover:[&_a]:underline")).toBe(true);
    expect(isArbitraryClass("[&_a]:underline")).toBe(true);
    expect(isArbitraryClass("fill-(--chart-1)")).toBe(true);
    expect(isArbitraryClass("w-64")).toBe(false);
    expect(isArbitraryClass("bg-destructive/10")).toBe(false);
    expect(isArbitraryClass("size-(--x")).toBe(false);
  });
});
