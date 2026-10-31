// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Argument parity between an English message and its translation (ADR 0029, batch 5 decision (j)).
 * Browser-safe, so runtimes that merge translations (email) can check them without the catalog tooling.
 */
import { type MessageAst, parseMessage } from "./format.ts";

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
