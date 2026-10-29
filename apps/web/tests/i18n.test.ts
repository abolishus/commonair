// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Repository checks for the message catalogs (ADR 0029 decision 2): the JSON namespaces under
 * `src/i18n/locales/`, the generated key modules, and how source code uses keys.
 */
import { checkCatalog, readNamespaces, renderKeyModules } from "@commonair/i18n/catalog";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { t } from "../src/i18n/index.ts";
import { NAMESPACES } from "../src/i18n/keys/index.gen.ts";

const SRC = new URL("../src/", import.meta.url).pathname;
const I18N = join(SRC, "i18n/");
const LOCALES = join(I18N, "locales");
const KEYS = join(I18N, "keys");

/**
 * Keys defined but used nowhere outside `src/i18n/`. Empty: the two found at the switch to JSON
 * (`nav.account`, `safety.appealq.intro`) were dead and removed. Add a key here only with a reason.
 */
const UNUSED_ALLOWED: readonly string[] = [];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".gen.ts") ? [full] : [];
  });
}

const files = sources(SRC).map((f) => [f, readFileSync(f, "utf8")] as const);
const appFiles = files.filter(([f]) => !f.startsWith(I18N));
const namespaces = readNamespaces(LOCALES);

describe("message catalogs", () => {
  it("has English namespaces, including the empty ones later units fill", () => {
    const english = namespaces.filter((ns) => ns.lang === "en").map((ns) => ns.name);
    expect(english).toEqual([...NAMESPACES]);
    for (const name of ["core", "e8-studio", "e8-viewer", "e9-consent", "e9-console", "n2-consent"])
      expect(english).toContain(name);
    expect(Object.keys(en).length).toBeGreaterThan(1800);
  });

  it("passes the catalog check (unique keys, names, every message parses, no orphan translation)", () => {
    expect(checkCatalog(namespaces)).toEqual([]);
  });

  it("has fresh generated key modules (`bun run i18n:gen`)", () => {
    const expected = renderKeyModules(namespaces);
    for (const [name, content] of Object.entries(expected)) {
      const path = join(KEYS, name);
      expect(existsSync(path), `${name} is missing`).toBe(true);
      expect(readFileSync(path, "utf8"), `${name} is stale: run bun run i18n:gen`).toBe(content);
    }
    const extra = readdirSync(KEYS).filter((f) => f.endsWith(".gen.ts") && !(f in expected));
    expect(extra).toEqual([]);
  });

  it("has every key the app uses", () => {
    const used = new Set<string>();
    for (const [, text] of files) for (const m of text.matchAll(/\bt\(\s*"([^"]+)"/g)) if (m[1]) used.add(m[1]);
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter((k) => !(k in en))).toEqual([]);
  });

  it("uses every key of every namespace outside src/i18n/", () => {
    const used = appFiles.map(([, text]) => text).join("\n");
    const unused = Object.keys(en).filter((k) => !used.includes(`"${k}"`) && !UNUSED_ALLOWED.includes(k));
    expect(unused).toEqual([]);
    // The allowlist only shrinks: a key it names that is now used (or gone) must leave it.
    expect(UNUSED_ALLOWED.filter((k) => !(k in en) || used.includes(`"${k}"`))).toEqual([]);
  });

  it("never builds keys at runtime (the checks above would miss them)", () => {
    // `t(LABELS[code])` over a `Record<Code, MessageKey>` of literals is fine: the literals are
    // checked above and the compiler checks the map. Template literals, concatenation and casts
    // defeat both.
    const problems: string[] = [];
    for (const [file, text] of appFiles) {
      const where = file.slice(SRC.length);
      if (/\bt\(\s*`/.test(text)) problems.push(`${where}: template literal in t()`);
      if (/\bt\(\s*[^,()]*\+/.test(text)) problems.push(`${where}: concatenation in t()`);
      if (/\bas\s+MessageKey\b/.test(text)) problems.push(`${where}: \`as MessageKey\``);
      if (/MessageKey\b[^;\n]*`[^`]*\$\{/.test(text)) problems.push(`${where}: template literal as a MessageKey`);
    }
    expect(problems).toEqual([]);
  });

  it("keeps en.ts a view of the JSON catalogs, with no keys of its own", () => {
    const text = readFileSync(join(I18N, "en.ts"), "utf8");
    expect(text).not.toMatch(/^\s*"[a-z][A-Za-z0-9]*\.[^"]*":/m);
  });

  it("keeps the source-locale exports out of app code (tests only)", () => {
    // `locale` and `uiMessages` are English constants for tests; app code must follow the request.
    const offenders = appFiles
      .filter(([, text]) =>
        [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[./]*i18n\/index\.ts"/g)].some((m) =>
          (m[1] ?? "").split(",").some((name) => /^\s*(locale|uiMessages)\s*$/.test(name)),
        ),
      )
      .map(([f]) => f.slice(SRC.length));
    expect(offenders).toEqual([]);
  });

  it("maps every auth error code to a catalog key", () => {
    const text = readFileSync(join(SRC, "lib/form-errors.ts"), "utf8");
    for (const m of text.matchAll(/:\s*"(error\.[a-zA-Z]+)"/g)) expect(m[1] && m[1] in en).toBe(true);
  });

  it("fills placeholders and keeps unknown ones", () => {
    expect(t("home.title", { name: "Test Air" })).toBe("Welcome to Test Air");
    expect(t("legal.version", {})).toBe("Version {version}");
    expect(t("nav.signIn")).toBe("Sign in");
  });

  it("formats the converted plurals", () => {
    expect(t("follow.count", { count: 1 })).toBe("1 follower");
    expect(t("follow.count", { count: 0 })).toBe("0 followers");
    expect(t("follow.count", { count: 12_345 })).toBe("12,345 followers");
  });
});
