// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Locale-aware formatting goes through `@commonair/ui`'s formatters (`packages/ui/src/lib/format.ts`,
 * ADR 0029 decision 4), called with the caller's `activeLocale()`. In `src/`: no `new Intl.*` or
 * `Intl.<x>(`, and no `toLocaleString()`, `toLocaleDateString(` or `toLocaleTimeString(` without a
 * locale (they would format in the runtime's locale, so the server and the browser could
 * disagree). `toLocaleLowerCase` and friends are fine. `packages/ui/tests/intl-policy.test.ts` is
 * the same check for the design system.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const appRoot = join(import.meta.dirname, "..");

/** file → reason; a hit in a listed file is allowed. Expected to stay empty. */
const ALLOWLIST: Readonly<Record<string, string>> = {};

const PATTERNS = [
  /\bnew\s+Intl\.[A-Za-z]+/g,
  /\bIntl\.[A-Za-z]+\s*\(/g,
  /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined\b)/g,
];

/** Blank `//` and `/* *\/` comments (string-aware), keeping line breaks so line numbers survive. */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      // A quote or apostrophe never spans lines (JSX text like "don't" must not swallow the file).
      if (ch === quote || (ch === "\n" && quote !== "`")) quote = null;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      out += ch;
      i++;
    }
  }
  return out;
}

/** `line: snippet` for every policy hit in one file's source. */
function scanIntl(source: string): Array<{ line: number; snippet: string }> {
  const code = stripComments(source);
  const hits: Array<{ line: number; snippet: string }> = [];
  for (const pattern of PATTERNS)
    for (const match of code.matchAll(pattern)) {
      const line = code.slice(0, match.index).split("\n").length;
      if (!hits.some((hit) => hit.line === line)) hits.push({ line, snippet: match[0] });
    }
  return hits.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [path] : [];
  });
}

describe("intl policy (apps/web/src)", () => {
  it("formats through @commonair/ui's formatters", () => {
    const report: string[] = [];
    for (const file of sourceFiles(join(appRoot, "src"))) {
      const rel = relative(appRoot, file);
      if (ALLOWLIST[rel]) continue;
      for (const hit of scanIntl(readFileSync(file, "utf8"))) report.push(`${rel}:${hit.line}: ${hit.snippet}`);
    }
    expect(report, `use formatPercent/formatNumber/formatUnit/… from @commonair/ui:\n${report.join("\n")}`).toEqual([]);
  });

  it("keeps a reason for every allowlist entry", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(statSync(join(appRoot, file)).isFile()).toBe(true);
      expect(reason.trim()).not.toBe("");
    }
  });

  it("catches a planted fixture and ignores comments and locale-aware calls", () => {
    const fixture = [
      "export const a = new Intl.NumberFormat(locale).format(n);",
      "export const b = Intl.supportedValuesOf('currency');",
      "export const c = when.toLocaleString();",
      "export const d = when.toLocaleDateString(undefined);",
      "export const e = when.toLocaleTimeString();",
      "export const ok = when.toLocaleString(activeLocale()) + q.toLocaleLowerCase(locale);",
      "// const x = new Intl.DateTimeFormat();",
      "/** n.toLocaleString() */",
      "export const s = `${new Intl.PluralRules(locale).select(1)}`;",
    ].join("\n");
    expect(scanIntl(fixture).map((hit) => hit.line)).toEqual([1, 2, 3, 4, 5, 9]);
  });
});
