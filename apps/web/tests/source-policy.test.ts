// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * apps/web composes `@commonair/ui`; it never builds its own controls or styling (AGENTS.md "Design
 * rules (web)", E4a). This scans `src/**` (except the generated route tree and `src/server/**`) and
 * fails, with file and line, on: raw interactive HTML, `role=` on div/span, arbitrary Tailwind
 * values/properties/variants, color literals, imports that bypass a house primitive, native
 * `title=` tooltips, `style=`, `alert/confirm/prompt`, and raw media or custom elements.
 * One-off exceptions go in ALLOWLIST with a reason; unused entries fail too.
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
  | "native-title"
  | "inline-style"
  | "native-dialog-fn"
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
  reason: string;
}

const ALLOWLIST: AllowEntry[] = [
  {
    file: "src/player/player.tsx",
    rule: "raw-media-element",
    reason:
      "The live <video> is PlayerChrome's child; hls.js, the heartbeat stats and the harness probe need the element.",
  },
  {
    file: "src/components/altcha-field.tsx",
    rule: "custom-element",
    reason: "The self-hosted ALTCHA proof-of-work widget is a web component; there is no React or shadcn equivalent.",
  },
];

const RAW_INTERACTIVE = new Set(["button", "input", "select", "textarea", "table", "dialog"]);
const RAW_MEDIA = new Set(["video", "audio", "iframe", "canvas", "object", "embed"]);
/** `@commonair/ui/components/*` modules with a house replacement (AGENTS.md "use X, not Y"). */
const HOUSE_REPLACED = {
  "alert-dialog": "ConfirmDialog",
  avatar: "ChannelAvatar",
  skeleton: "Skeleton* from @commonair/ui",
  sonner: "toast from @commonair/ui/toast",
  table: "DataTable from @commonair/ui/blocks/data",
  kbd: "Kbd/Shortcut from @commonair/ui",
} as const;

/** Blank out comments (keeping line breaks) so prose about a rule never trips it. */
export function stripComments(text: string): string {
  const keepLines = (m: string) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:\\"'`])\/\/[^\n]*/gm, (m, before: string) => before + keepLines(m.slice(before.length)));
}

interface OpeningTag {
  name: string;
  attrs: string;
  index: number;
}

/**
 * JSX opening tags. A `<` directly after an identifier, `)` or `]` is a generic or a comparison,
 * not JSX. Attributes run to the first `>` outside braces and quotes.
 */
export function openingTags(text: string): OpeningTag[] {
  const tags: OpeningTag[] = [];
  const start = /<([A-Za-z][\w.-]*)/g;
  for (let m = start.exec(text); m; m = start.exec(text)) {
    const prev = m.index > 0 ? (text[m.index - 1] ?? "") : "";
    if (/[\w$)\].]/.test(prev)) continue;
    let depth = 0;
    let quote: string | null = null;
    let i = start.lastIndex;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && text[i - 1] !== "\\") quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push({ name: m[1] ?? "", attrs: text.slice(start.lastIndex, i), index: m.index });
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

/** A Tailwind arbitrary value (`h-[3px]`), property (`[mask:x]`) or variant (`[&>svg]:x`, `min-[420px]:x`). */
export function isArbitraryClass(token: string): boolean {
  return /-\[[^\]\s]+\]/.test(token) || /(^|:)!?\[[a-z-]+:[^\]\s]+\]/.test(token) || /(^|:)\[&[^\]\s]*\]:/.test(token);
}

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

export function findViolations(file: string, source: string): Violation[] {
  const text = stripComments(source);
  const out: Violation[] = [];
  const add = (rule: Rule, index: number, snippet: string) =>
    out.push({ file, line: lineOf(text, index), rule, snippet: snippet.trim().slice(0, 80) });

  if (file.endsWith(".tsx"))
    for (const tag of openingTags(text)) {
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
    const hex = /(?<![\w/&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/.exec(lit.value);
    if (hex) add("color-literal", lit.index + hex.index, hex[0]);
  }

  const patterns: [Rule, RegExp][] = [
    ["color-literal", /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/g],
    ["banned-import", /\b(?:from|import)\s*\(?\s*["'](?:@base-ui\/react(?:\/[^"']*)?|sonner)["']/g],
    [
      "banned-import",
      new RegExp(
        `\\b(?:from|import)\\s*\\(?\\s*["']@commonair/ui/components/(?:${Object.keys(HOUSE_REPLACED).join("|")})["']`,
        "g",
      ),
    ],
    ["native-dialog-fn", /(?<![\w$.])(?:window\.|globalThis\.)?(?:alert|confirm|prompt)\s*\(/g],
    ["custom-element", /\bcreateElement\(\s*["'][a-z][\w]*-[\w-]*["']/g],
  ];
  for (const [rule, re] of patterns) for (const m of text.matchAll(re)) add(rule, m.index ?? 0, m[0]);
  return out;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return full === join(SRC, "server") ? [] : sources(full);
    return /\.(ts|tsx)$/.test(name) && name !== "routeTree.gen.ts" ? [full] : [];
  });
}

const allowed = (v: Violation) => ALLOWLIST.some((a) => a.file === v.file && a.rule === v.rule);

describe("apps/web source policy", () => {
  const all = sources(SRC).flatMap((full) => findViolations(relative(WEB, full), readFileSync(full, "utf8")));

  it("scans the app (and not the server or the generated route tree)", () => {
    const files = sources(SRC).map((f) => relative(WEB, f));
    expect(files).toContain("src/routes/_app.tsx");
    expect(files).toContain("src/routes/_studio/relays.tsx");
    expect(files.some((f) => f.startsWith("src/server/"))).toBe(false);
    expect(files).not.toContain("src/routeTree.gen.ts");
  });

  it("has no violations outside the allowlist", () => {
    const report = all.filter((v) => !allowed(v)).map((v) => `${v.file}:${v.line} ${v.rule}: ${v.snippet}`);
    expect(report).toEqual([]);
  });

  it.each(ALLOWLIST)("allowlist entry $file ($rule) is still needed and explained", (entry) => {
    expect(existsSync(join(WEB, entry.file))).toBe(true);
    expect(entry.reason.length).toBeGreaterThan(20);
    expect(all.some((v) => v.file === entry.file && v.rule === entry.rule)).toBe(true);
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
    ['<span title="Full name">x</span>', "native-title"],
    ["<a title={label} href={u}>x</a>", "native-title"],
    ["<div style={{ width: 3 }} />", "inline-style"],
    ["<Bar style={{ width: `${share}%` }} />", "inline-style"],
    ['if (confirm("Sure?")) go();', "native-dialog-fn"],
    ["window.alert(message);", "native-dialog-fn"],
    ["prompt(question)", "native-dialog-fn"],
    ['<video src="x" />', "raw-media-element"],
    ['<iframe src="x" />', "raw-media-element"],
    ["<altcha-widget auto />", "custom-element"],
    ['React.createElement("altcha-widget", props)', "custom-element"],
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
  ])("does not flag %s", (source) => {
    expect(rules(source)).toEqual([]);
  });

  it("reports the line of the offending tag", () => {
    const [v] = findViolations("x.tsx", 'const a = 1;\n\nconst b = <div\n  role="button"\n/>;');
    expect(v).toMatchObject({ rule: "role-on-div-span", line: 3 });
  });

  it("leaves JSX rules to .tsx files", () => {
    expect(rules('const s = "<button>";', "x.ts")).toEqual([]);
  });

  it("keeps line numbers when stripping comments", () => {
    const stripped = stripComments("a /* x\ny */ b\n// c\nd");
    expect(stripped.split("\n")).toHaveLength(4);
    expect(stripped).not.toContain("x");
    expect(stripped.split("\n")[3]).toBe("d");
  });

  it("recognizes Tailwind arbitrary syntax only", () => {
    expect(isArbitraryClass("w-[3px]")).toBe(true);
    expect(isArbitraryClass("hover:[&_a]:underline")).toBe(true);
    expect(isArbitraryClass("[&_a]:underline")).toBe(true);
    expect(isArbitraryClass("w-64")).toBe(false);
    expect(isArbitraryClass("bg-destructive/10")).toBe(false);
  });
});
