// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MessageAst, type MessageNode, parseMessage, printMessage } from "./format.ts";

/** The pseudo-locale (ADR 0029 decision 6): accented, about 35% longer, bracketed. */
export const PSEUDO_LOCALE = "en-XA";

const PLAIN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
// One precomposed code point per letter, so lengths and cursor movement stay simple.
const ACCENTED = "åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ";
// Both strings are BMP-only (one UTF-16 unit per letter), so splitting by unit is exact.
const MAP = new Map(PLAIN.split("").map((ch, i) => [ch, ACCENTED.split("")[i] as string]));
const PAD = "~";

function accent(text: string): string {
  let out = "";
  for (const ch of text) out += MAP.get(ch) ?? ch;
  return out;
}

function textLength(ast: MessageAst): number {
  let n = 0;
  for (const node of ast) {
    if (typeof node === "string") n += node.length;
    else if (node.type === "plural" || node.type === "select") {
      // The longest branch is what can overflow.
      let longest = 0;
      for (const branch of node.options.values()) longest = Math.max(longest, textLength(branch));
      n += longest;
    }
  }
  return n;
}

function transform(ast: MessageAst): MessageNode[] {
  return ast.map((node): MessageNode => {
    if (typeof node === "string") return accent(node);
    if (node.type === "plural" || node.type === "select") {
      const options = new Map([...node.options].map(([key, branch]) => [key, transform(branch)] as const));
      return { ...node, options };
    }
    return node;
  });
}

/** Accent ASCII letters, pad by ~35%, wrap in [ ]; placeholders, plural/select syntax and `#` untouched. */
export function pseudoLocalize(source: string): string {
  if (source === "") return "";
  let ast: MessageAst;
  try {
    ast = parseMessage(source);
  } catch {
    // Not a valid message (a design-system string with a stray brace): still visibly pseudo.
    return `[${accent(source)}]`;
  }
  const pad = PAD.repeat(Math.ceil(textLength(ast) * 0.35));
  return `[${printMessage(transform(ast))}${pad}]`;
}
