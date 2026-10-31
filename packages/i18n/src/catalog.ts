// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Catalog tooling (ADR 0029 decision 2): read `<dir>/<lang>/<namespace>.json`, check it, and
 * render the typed key modules. Node-only (reads files); the runtime never imports it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { I18nSyntaxError, type MessageAst, parseMessage } from "./format.ts";

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

export type ArgumentKind = "simple" | "plural" | "selectordinal" | "select";

/**
 * What a parsed message's arguments look like: kinds per name, the case names of each select, and
 * each plural's exact-number cases (`=0`) and offsets, which a translation must keep.
 */
interface ArgumentShape {
  kinds: Map<string, Set<ArgumentKind>>;
  selectCases: Map<string, Set<string>>;
  exactCases: Map<string, Set<string>>;
  offsets: Map<string, Set<number>>;
}

const addTo = <T>(map: Map<string, Set<T>>, name: string, values: Iterable<T>) => {
  const set = map.get(name) ?? new Set<T>();
  for (const value of values) set.add(value);
  map.set(name, set);
};

function argumentShape(ast: MessageAst): ArgumentShape {
  const shape: ArgumentShape = { kinds: new Map(), selectCases: new Map(), exactCases: new Map(), offsets: new Map() };
  const add = (name: string, kind: ArgumentKind) => {
    const kinds = shape.kinds.get(name) ?? new Set<ArgumentKind>();
    kinds.add(kind);
    shape.kinds.set(name, kinds);
  };
  const walk = (nodes: MessageAst) => {
    for (const node of nodes) {
      if (typeof node === "string" || node.type === "pound") continue;
      if (node.type === "arg") {
        add(node.name, "simple");
        continue;
      }
      if (node.type === "plural") {
        add(node.name, node.ordinal ? "selectordinal" : "plural");
        // "=0 {No votes}" reads differently from "0 votes"; `offset` shifts what `#` shows.
        addTo(
          shape.exactCases,
          node.name,
          [...node.options.keys()].filter((selector) => selector.startsWith("=")),
        );
        addTo(shape.offsets, node.name, [node.offset]);
      } else {
        add(node.name, "select");
        addTo(shape.selectCases, node.name, node.options.keys());
      }
      for (const branch of node.options.values()) walk(branch);
    }
  };
  walk(ast);
  return shape;
}

/** Every argument of a message (nested ones included) and how it is used; `#` is not an argument. */
export function messageArguments(message: string): Map<string, ArgumentKind[]> {
  const { kinds } = argumentShape(parseMessage(message));
  return new Map([...kinds].map(([name, set]) => [name, [...set].sort()]));
}

const describeKinds = (kinds: Map<string, Set<ArgumentKind>>): string =>
  [...kinds]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, set]) => (set.has("simple") && set.size === 1 ? name : `${name}: ${[...set].sort().join("|")}`))
    .join(", ") || "none";

/**
 * Whether a translation can stand in for its English source (ADR 0029, batch 5 decision (j)): the
 * same argument names used the same ways, every select case and exact plural case (`=0`) English
 * names, and the same plural offsets. Plural categories may differ (languages have different ones;
 * the parser already requires `other`). An argument English uses only through `#` must not become
 * `{n}` inside the plural: `#` is formatted for the locale, `{n}` is not. Undefined when fine or
 * when either side does not parse (the parse check reports that).
 */
export function checkTranslation(english: string, translated: string): string | undefined {
  let source: ArgumentShape;
  let target: ArgumentShape;
  try {
    source = argumentShape(parseMessage(english));
    target = argumentShape(parseMessage(translated));
  } catch {
    return undefined;
  }
  if (describeKinds(source.kinds) !== describeKinds(target.kinds))
    return `arguments differ (English: ${describeKinds(source.kinds)}; translation: ${describeKinds(target.kinds)})`;
  for (const [name, cases] of source.selectCases) {
    const missing = [...cases].filter((selector) => !target.selectCases.get(name)?.has(selector));
    if (missing.length > 0) return `select ${name} is missing ${missing.join(", ")}`;
  }
  for (const [name, cases] of source.exactCases) {
    const missing = [...cases].filter((selector) => !target.exactCases.get(name)?.has(selector));
    if (missing.length > 0) return `plural ${name} is missing ${missing.join(", ")}`;
  }
  for (const [name, offsets] of source.offsets) {
    const theirs = [...(target.offsets.get(name) ?? [])].sort((a, b) => a - b).join(",");
    if ([...offsets].sort((a, b) => a - b).join(",") !== theirs) return `plural ${name} offset differs`;
  }
  return undefined;
}

export interface Coverage {
  /** English keys. */
  total: number;
  /** English keys the locale has (a value equal to English counts: some strings stay English). */
  translated: number;
  /** `<namespace>.json: <key>` for every English key the locale lacks, in file order. */
  missing: string[];
}

/** How much of English a locale covers, over every English namespace. */
export function coverage(namespaces: readonly Namespace[], lang: string): Coverage {
  const have = new Map<string, Set<string>>();
  for (const ns of namespaces) if (ns.lang === lang) have.set(ns.name, new Set(ns.entries.map(([k]) => k)));
  const result: Coverage = { total: 0, translated: 0, missing: [] };
  for (const ns of namespaces) {
    if (ns.lang !== SOURCE_LOCALE) continue;
    const keys = have.get(ns.name);
    for (const [key] of ns.entries) {
      result.total++;
      if (keys?.has(key)) result.translated++;
      else result.missing.push(`${ns.name}.json: ${key}`);
    }
  }
  return result;
}

/** Problems with the catalogs, one line each; empty when they are fine. */
export function checkCatalog(namespaces: readonly Namespace[]): string[] {
  const problems: string[] = [];
  const english = namespaces.filter((ns) => ns.lang === SOURCE_LOCALE);
  if (english.length === 0) problems.push(`no ${SOURCE_LOCALE}/ catalog: English is the source of truth`);
  const englishKeys = new Map<string, Map<string, string>>(english.map((ns) => [ns.name, new Map(ns.entries)]));
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
      } else if (inEnglish) {
        const source = inEnglish.get(key);
        if (source === undefined) problems.push(`${where}: key ${key} is not in ${SOURCE_LOCALE}/${ns.name}.json`);
        else {
          const mismatch = checkTranslation(source, message);
          if (mismatch) problems.push(`${where}: ${key} ${mismatch}`);
        }
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
