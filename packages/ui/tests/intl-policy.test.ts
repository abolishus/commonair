// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Locale-aware formatting lives in `src/lib/format.ts` (ADR 0029 decision 4). Everywhere else in
 * `src/`: no `new Intl.*` or `Intl.<x>(`, and nowhere a `toLocaleString()`,
 * `toLocaleDateString(` or `toLocaleTimeString(` without a locale (they would format in the
 * runtime's locale, so the server and the browser could disagree). `toLocaleLowerCase` and
 * friends are fine. `apps/web/tests/intl-policy.test.ts` is the same check for the app.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const pkgRoot = join(import.meta.dirname, "..");
const FORMAT_MODULE = "src/lib/format.ts";

/** file → reason; a hit in a listed file is allowed. Expected to stay empty. */
const ALLOWLIST: Readonly<Record<string, string>> = {};

const CONSTRUCTOR = /\bnew\s+Intl\.[A-Za-z]+/g;
const CALL = /\bIntl\.[A-Za-z]+\s*\(/g;
const NO_LOCALE = /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined\b)/g;

/** Blank `//` and `/* *\/` comments (string-aware), keeping line breaks so line numbers survive. */
export function stripComments(text: string): string {
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

export interface IntlHit {
  line: number;
  snippet: string;
}

/** Policy hits in one file's source; `formatModule` true allows `Intl` constructors and calls. */
export function scanIntl(source: string, formatModule = false): IntlHit[] {
  const code = stripComments(source);
  const patterns = formatModule ? [NO_LOCALE] : [CONSTRUCTOR, CALL, NO_LOCALE];
  const hits: IntlHit[] = [];
  for (const pattern of patterns)
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
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("intl policy (packages/ui/src)", () => {
  test("formatting goes through src/lib/format.ts", () => {
    const report: string[] = [];
    for (const file of sourceFiles(join(pkgRoot, "src"))) {
      const rel = relative(pkgRoot, file);
      if (ALLOWLIST[rel]) continue;
      for (const hit of scanIntl(readFileSync(file, "utf8"), rel === FORMAT_MODULE))
        report.push(`${rel}:${hit.line}: ${hit.snippet}`);
    }
    expect(report, `use the formatters in ${FORMAT_MODULE}:\n${report.join("\n")}`).toEqual([]);
  });

  test("every allowlist entry is a file with a reason", () => {
    for (const [file, reason] of Object.entries(ALLOWLIST)) {
      expect(statSync(join(pkgRoot, file)).isFile()).toBe(true);
      expect(reason.trim()).not.toBe("");
    }
  });
});

describe("scanIntl", () => {
  test("flags constructors, calls and locale-less toLocale*String", () => {
    const fixture = [
      "const a = new Intl.NumberFormat(locale).format(1);",
      "const b = Intl.getCanonicalLocales(tag);",
      "const c = n.toLocaleString();",
      "const d = date.toLocaleDateString( );",
      "const e = date.toLocaleTimeString(undefined, { hour: 'numeric' });",
      "const ok1 = n.toLocaleString(locale);",
      "const ok2 = name.toLocaleLowerCase(locale);",
      "const ok3: Intl.NumberFormatOptions = {};",
      "// new Intl.DateTimeFormat() in a comment",
      "/* x.toLocaleString() */",
      'const ok4 = "https://example.test"; const f = new Intl.Collator(locale);',
    ].join("\n");
    expect(scanIntl(fixture)).toEqual([
      { line: 1, snippet: "new Intl.NumberFormat" },
      { line: 2, snippet: "Intl.getCanonicalLocales(" },
      { line: 3, snippet: ".toLocaleString()" },
      { line: 4, snippet: ".toLocaleDateString( )" },
      { line: 5, snippet: ".toLocaleTimeString(undefined" },
      { line: 11, snippet: "new Intl.Collator" },
    ]);
  });

  test("the format module may construct Intl formatters but not format without a locale", () => {
    expect(scanIntl("new Intl.NumberFormat(locale); Intl.getCanonicalLocales(tag);", true)).toEqual([]);
    expect(scanIntl("value.toLocaleString()", true)).toEqual([{ line: 1, snippet: ".toLocaleString()" }]);
  });
});
