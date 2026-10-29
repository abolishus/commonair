// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Catalog tooling (ADR 0029 decision 2): read `<dir>/<lang>/<namespace>.json`, check it, and
 * render the typed key modules. Node-only (reads files); the runtime never imports it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { I18nSyntaxError, parseMessage } from "./format.ts";

export const SOURCE_LOCALE = "en";
export const NAMESPACE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Later segments may carry `_`: 34 keys end in an enum value such as `self_harm`. */
export const KEY_NAME = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;
const LOCALE_DIR = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface Namespace {
  lang: string;
  name: string;
  /** Path of the JSON file, for messages. */
  file: string;
  /** Entries in file order, duplicates kept so the check can report them. */
  entries: ReadonlyArray<readonly [key: string, message: string]>;
  /** Set when the file is not a flat JSON object of strings. */
  error?: string;
}

/** Parse a flat `{ "key": "message" }` object keeping order and duplicate keys. */
export function parseFlatJson(text: string): Array<[string, string]> {
  let pos = 0;
  const fail = (what: string): never => {
    throw new Error(`${what} at offset ${pos}`);
  };
  const ws = () => {
    while (pos < text.length && /\s/.test(text[pos] as string)) pos++;
  };
  const str = (): string => {
    if (text[pos] !== '"') fail("expected a string");
    const start = pos++;
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === "\\" ? 2 : 1;
    if (pos >= text.length) fail("unterminated string");
    pos++;
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const entries: Array<[string, string]> = [];
  ws();
  if (text[pos] !== "{") fail("expected '{'");
  pos++;
  ws();
  if (text[pos] === "}") pos++;
  else
    for (;;) {
      ws();
      const key = str();
      ws();
      if (text[pos] !== ":") fail("expected ':'");
      pos++;
      ws();
      entries.push([key, str()]);
      ws();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "}") {
        pos++;
        break;
      }
      fail("expected ',' or '}'");
    }
  ws();
  if (pos < text.length) fail("trailing content");
  return entries;
}

/** Every `<dir>/<lang>/<namespace>.json`, sorted by language then namespace. */
export function readNamespaces(dir: string): Namespace[] {
  const out: Namespace[] = [];
  for (const lang of readdirSync(dir).sort()) {
    const langDir = join(dir, lang);
    if (!statSync(langDir).isDirectory()) continue;
    for (const fileName of readdirSync(langDir).sort()) {
      if (!fileName.endsWith(".json")) continue;
      const file = join(langDir, fileName);
      const name = fileName.slice(0, -".json".length);
      try {
        out.push({ lang, name, file, entries: parseFlatJson(readFileSync(file, "utf8")) });
      } catch (error) {
        out.push({ lang, name, file, entries: [], error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return out;
}

/** Problems with the catalogs, one line each; empty when they are fine. */
export function checkCatalog(namespaces: readonly Namespace[]): string[] {
  const problems: string[] = [];
  const english = namespaces.filter((ns) => ns.lang === SOURCE_LOCALE);
  if (english.length === 0) problems.push(`no ${SOURCE_LOCALE}/ catalog: English is the source of truth`);
  const englishKeys = new Map<string, Set<string>>(english.map((ns) => [ns.name, new Set(ns.entries.map(([k]) => k))]));
  const owner = new Map<string, string>();
  for (const ns of namespaces) {
    const where = `${ns.lang}/${ns.name}.json`;
    if (ns.error) {
      problems.push(`${where}: not a flat object of strings (${ns.error})`);
      continue;
    }
    if (!LOCALE_DIR.test(ns.lang)) problems.push(`${ns.lang}/: not a locale tag`);
    if (!NAMESPACE_NAME.test(ns.name)) problems.push(`${where}: namespace name must match ${NAMESPACE_NAME}`);
    const inEnglish = englishKeys.get(ns.name);
    if (ns.lang !== SOURCE_LOCALE && !inEnglish) problems.push(`${where}: no ${SOURCE_LOCALE}/${ns.name}.json`);
    const seen = new Set<string>();
    for (const [key, message] of ns.entries) {
      if (seen.has(key)) problems.push(`${where}: duplicate key ${key}`);
      seen.add(key);
      if (!KEY_NAME.test(key)) problems.push(`${where}: key ${JSON.stringify(key)} must match ${KEY_NAME}`);
      try {
        parseMessage(message);
      } catch (error) {
        const detail = error instanceof I18nSyntaxError ? error.message : String(error);
        problems.push(`${where}: ${key} does not parse (${detail})`);
      }
      if (ns.lang === SOURCE_LOCALE) {
        const first = owner.get(key);
        if (first !== undefined && first !== ns.name) problems.push(`${where}: key ${key} is also in ${first}.json`);
        else owner.set(key, ns.name);
      } else if (inEnglish && !inEnglish.has(key)) {
        problems.push(`${where}: key ${key} is not in ${SOURCE_LOCALE}/${ns.name}.json`);
      }
    }
  }
  return problems;
}

// REUSE-IgnoreStart
const HEADER = [
  "// SPDX-FileCopyrightText: 2026 CommonAir contributors",
  "// SPDX-License-Identifier: AGPL-3.0-or-later",
  "",
  "// Generated by `bun run i18n:gen`; do not edit.",
  "",
  "",
].join("\n");
// REUSE-IgnoreEnd

function typeName(namespace: string): string {
  return namespace
    .split("-")
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join("");
}

/** The generated key modules, file name → content: `<namespace>.gen.ts` per English namespace and `index.gen.ts`. */
export function renderKeyModules(namespaces: readonly Namespace[]): Record<string, string> {
  const english = namespaces
    .filter((ns) => ns.lang === SOURCE_LOCALE)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: Record<string, string> = {};
  for (const ns of english) {
    const keys = [...new Set(ns.entries.map(([k]) => k))];
    const union = keys.length === 0 ? " never" : keys.map((k) => `\n  | ${JSON.stringify(k)}`).join("");
    out[`${ns.name}.gen.ts`] = `${HEADER}export type Key =${union};\n`;
  }
  const imports = english.map((ns) => `import type { Key as ${typeName(ns.name)} } from "./${ns.name}.gen.ts";\n`);
  const union = english.length === 0 ? " never" : english.map((ns) => `\n  | ${typeName(ns.name)}`).join("");
  const names = english.map((ns) => `\n  ${JSON.stringify(ns.name)},`).join("");
  out["index.gen.ts"] =
    `${HEADER}${imports.join("")}\n` +
    `/** Every message key, typed from the English catalogs. */\n` +
    `export type MessageKey =${union};\n\n` +
    `export const NAMESPACES = [${names}\n] as const;\n`;
  return out;
}
