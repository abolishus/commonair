// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ICU MessageFormat subset of ADR 0029 decision 1: `{name}`, `plural` (with `offset:` and
 * `=N`), `selectordinal` and `select`, nested. No number/date/time argument types: formatting
 * belongs to the UI primitives. Apostrophes follow ICU's "double optional" rule: `''` is one
 * quote, a quote before `{`, `}`, `#` (in a plural) or `|` starts quoted literal text, any other
 * quote is literal.
 */

export type MessageArgs = Readonly<Record<string, string | number>>;

export class I18nSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = "I18nSyntaxError";
    this.offset = offset;
  }
}

export interface ArgNode {
  readonly type: "arg";
  readonly name: string;
}
export interface PluralNode {
  readonly type: "plural";
  readonly name: string;
  readonly ordinal: boolean;
  readonly offset: number;
  /** Selector (`=0`, `one`, `other`, …) → branch, in source order. */
  readonly options: ReadonlyMap<string, MessageAst>;
}
export interface SelectNode {
  readonly type: "select";
  readonly name: string;
  readonly options: ReadonlyMap<string, MessageAst>;
}
export interface PoundNode {
  readonly type: "pound";
}
export type MessageNode = string | ArgNode | PluralNode | SelectNode | PoundNode;
export type MessageAst = readonly MessageNode[];

const PLURAL_KEYWORDS = new Set(["zero", "one", "two", "few", "many", "other"]);
const NAME = /[A-Za-z0-9_]/;
const SELECTOR = /[A-Za-z0-9_-]/;

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): MessageAst {
    const nodes = this.nodes(false, false);
    if (this.pos < this.src.length) throw new I18nSyntaxError("Unmatched '}'", this.pos);
    return nodes;
  }

  /** Text and arguments until the end, or until a `}` when `nested`. */
  private nodes(nested: boolean, inPlural: boolean): MessageNode[] {
    const out: MessageNode[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push(text);
      text = "";
    };
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos] as string;
      if (ch === "}") {
        if (nested) break;
        throw new I18nSyntaxError("Unmatched '}'", this.pos);
      }
      if (ch === "{") {
        flush();
        out.push(this.argument(inPlural));
        continue;
      }
      if (ch === "#" && inPlural) {
        flush();
        out.push({ type: "pound" });
        this.pos++;
        continue;
      }
      if (ch === "'") {
        text += this.apostrophe(inPlural);
        continue;
      }
      text += ch;
      this.pos++;
    }
    flush();
    return out;
  }

  private apostrophe(inPlural: boolean): string {
    const next = this.src[this.pos + 1];
    if (next === "'") {
      this.pos += 2;
      return "'";
    }
    if (next === "{" || next === "}" || next === "|" || (next === "#" && inPlural)) {
      // Quoted literal: runs to the next lone quote (or the end), `''` inside is one quote.
      let text = "";
      this.pos++;
      while (this.pos < this.src.length) {
        const ch = this.src[this.pos] as string;
        if (ch === "'") {
          if (this.src[this.pos + 1] === "'") {
            text += "'";
            this.pos += 2;
            continue;
          }
          this.pos++;
          return text;
        }
        text += ch;
        this.pos++;
      }
      return text;
    }
    this.pos++;
    return "'";
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos] as string)) this.pos++;
  }

  private word(pattern: RegExp): string {
    const start = this.pos;
    while (this.pos < this.src.length && pattern.test(this.src[this.pos] as string)) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private expect(ch: string, open: number): void {
    if (this.pos >= this.src.length) throw new I18nSyntaxError("Unclosed '{'", open);
    if (this.src[this.pos] !== ch) throw new I18nSyntaxError(`Expected '${ch}'`, this.pos);
    this.pos++;
  }

  private argument(inPlural: boolean): MessageNode {
    const open = this.pos;
    this.pos++;
    this.ws();
    const nameAt = this.pos;
    const name = this.word(NAME);
    if (!name) {
      if (this.pos >= this.src.length) throw new I18nSyntaxError("Unclosed '{'", open);
      throw new I18nSyntaxError("Expected an argument name", nameAt);
    }
    this.ws();
    if (this.src[this.pos] === "}") {
      this.pos++;
      return { type: "arg", name };
    }
    this.expect(",", open);
    this.ws();
    const typeAt = this.pos;
    const kind = this.word(/[a-z]/);
    if (kind !== "plural" && kind !== "selectordinal" && kind !== "select") {
      if (this.pos >= this.src.length) throw new I18nSyntaxError("Unclosed '{'", open);
      throw new I18nSyntaxError(`Unsupported argument type '${kind}'`, typeAt);
    }
    this.ws();
    this.expect(",", open);
    this.ws();
    if (kind === "select") {
      const options = this.options(open, false, inPlural);
      return { type: "select", name, options };
    }
    let offset = 0;
    if (this.src.startsWith("offset:", this.pos)) {
      this.pos += "offset:".length;
      this.ws();
      const at = this.pos;
      const digits = this.word(/[0-9]/);
      if (!digits) throw new I18nSyntaxError("Expected an offset", at);
      offset = Number(digits);
      this.ws();
    }
    const options = this.options(open, true, true);
    return { type: "plural", name, ordinal: kind === "selectordinal", offset, options };
  }

  private options(open: number, plural: boolean, inPlural: boolean): Map<string, MessageAst> {
    const options = new Map<string, MessageAst>();
    for (;;) {
      this.ws();
      if (this.pos >= this.src.length) throw new I18nSyntaxError("Unclosed '{'", open);
      if (this.src[this.pos] === "}") {
        if (!options.has("other")) throw new I18nSyntaxError("Missing 'other' option", this.pos);
        this.pos++;
        return options;
      }
      const at = this.pos;
      let selector: string;
      if (plural && this.src[this.pos] === "=") {
        this.pos++;
        const digits = this.word(/[0-9.]/);
        if (!/^\d+(\.\d+)?$/.test(digits)) throw new I18nSyntaxError("Expected a number after '='", at);
        selector = `=${Number(digits)}`;
      } else {
        selector = this.word(SELECTOR);
        if (!selector) throw new I18nSyntaxError("Expected an option selector", at);
        if (plural && !PLURAL_KEYWORDS.has(selector))
          throw new I18nSyntaxError(`Unknown plural category '${selector}'`, at);
      }
      if (options.has(selector)) throw new I18nSyntaxError(`Duplicate option '${selector}'`, at);
      this.ws();
      if (this.src[this.pos] !== "{") {
        if (this.pos >= this.src.length) throw new I18nSyntaxError("Unclosed '{'", open);
        throw new I18nSyntaxError("Expected '{' after an option selector", this.pos);
      }
      const branchOpen = this.pos;
      this.pos++;
      const branch = this.nodes(true, inPlural);
      if (this.pos >= this.src.length) throw new I18nSyntaxError("Unclosed '{'", branchOpen);
      this.pos++;
      options.set(selector, branch);
    }
  }
}

/** Parse once; throws I18nSyntaxError with the offset. */
export function parseMessage(source: string): MessageAst {
  return new Parser(source).parse();
}

const intlCache = new Map<string, Intl.PluralRules | Intl.NumberFormat>();

/** `en-XA` and anything `Intl` rejects use English rules. */
function intlLocale(locale: string): string {
  if (locale === "en-XA") return "en";
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {
    return "en";
  }
}

function pluralRules(locale: string, ordinal: boolean): Intl.PluralRules {
  const key = `${ordinal ? "o" : "c"}|${locale}`;
  let rules = intlCache.get(key) as Intl.PluralRules | undefined;
  if (!rules) {
    rules = new Intl.PluralRules(intlLocale(locale), { type: ordinal ? "ordinal" : "cardinal" });
    intlCache.set(key, rules);
  }
  return rules;
}

function numberFormat(locale: string): Intl.NumberFormat {
  const key = `n|${locale}`;
  let format = intlCache.get(key) as Intl.NumberFormat | undefined;
  if (!format) {
    format = new Intl.NumberFormat(intlLocale(locale));
    intlCache.set(key, format);
  }
  return format;
}

type Pound = { value: number } | { raw: string } | null;

function render(ast: MessageAst, args: MessageArgs | undefined, locale: string, pound: Pound): string {
  let out = "";
  for (const node of ast) {
    if (typeof node === "string") out += node;
    else if (node.type === "arg") {
      const value = args?.[node.name];
      out += value === undefined ? `{${node.name}}` : String(value);
    } else if (node.type === "pound") {
      if (pound === null) out += "#";
      else if ("value" in pound) out += numberFormat(locale).format(pound.value);
      else out += pound.raw;
    } else if (node.type === "select") {
      const value = args?.[node.name];
      const key = value === undefined ? "other" : String(value);
      const branch = (key !== "other" && node.options.get(key)) || node.options.get("other") || [];
      out += render(branch, args, locale, pound);
    } else {
      const value = args?.[node.name];
      if (typeof value === "number" && Number.isFinite(value)) {
        const branch =
          node.options.get(`=${value}`) ??
          node.options.get(pluralRules(locale, node.ordinal).select(value - node.offset)) ??
          node.options.get("other") ??
          [];
        out += render(branch, args, locale, { value: value - node.offset });
      } else {
        // Not a number (an empty total, a missing argument): `other`, and `#` shows what was given.
        out += render(node.options.get("other") ?? [], args, locale, {
          raw: value === undefined ? "" : String(value),
        });
      }
    }
  }
  return out;
}

/** Format with `locale`'s plural rules; unknown `{name}` placeholders are kept verbatim. */
export function formatMessage(message: string | MessageAst, args: MessageArgs | undefined, locale: string): string {
  const ast = typeof message === "string" ? parseMessage(message) : message;
  return render(ast, args, locale, null);
}

/** Write an AST back as message source (used by `pseudoLocalize`); quotes only where needed. */
export function printMessage(ast: MessageAst): string {
  return print(ast, false);
}

function printText(text: string, inPlural: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "{" || ch === "}" || (ch === "#" && inPlural)) out += `'${ch}'`;
    else if (ch === "'") {
      const next = text[i + 1];
      // A lone quote stays literal unless what follows could start a quote; at the end of the
      // text the next node may be an argument, so double it there.
      const special =
        next === undefined || next === "'" || next === "{" || next === "}" || next === "|" || next === "#";
      out += special ? "''" : "'";
    } else out += ch;
  }
  return out;
}

function print(ast: MessageAst, inPlural: boolean): string {
  let out = "";
  for (const node of ast) {
    if (typeof node === "string") out += printText(node, inPlural);
    else if (node.type === "arg") out += `{${node.name}}`;
    else if (node.type === "pound") out += "#";
    else {
      const kind = node.type === "select" ? "select" : node.ordinal ? "selectordinal" : "plural";
      const offset = node.type === "plural" && node.offset ? `offset:${node.offset} ` : "";
      const branchInPlural = node.type === "plural" || inPlural;
      const options = [...node.options].map(([key, branch]) => `${key} {${print(branch, branchInPlural)}}`).join(" ");
      out += `{${node.name}, ${kind}, ${offset}${options}}`;
    }
  }
  return out;
}
