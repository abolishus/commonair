// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The untranslated-literal scanner for the `en-XA` run of `e2e-basic` (batch 5 decision (k), ADR
 * 0029 decision 6). Under the pseudo-locale every catalog message renders accented and bracketed,
 * so any run of three or more plain ASCII letters left on the page, outside user content and
 * outside a pseudo-localized segment, is text that never went through `t()`.
 *
 * `findLiterals` is pure; `scanPage` collects a page's visible text and accessible names in the
 * browser and runs it.
 */
import type { Page } from "playwright";
// Relative, not `@commonair/i18n`: the harness does not depend on that workspace (yet).
import { pseudoLocalize } from "../../../packages/i18n/src/pseudo.ts";

/** Where a scanned string came from on the page. */
export type ScannedKind =
  | "text"
  | "aria-label"
  | "aria-description"
  | "aria-roledescription"
  | "aria-valuetext"
  | "placeholder"
  | "alt"
  | "title"
  | "value"
  | "document-title";

export interface ScannedNode {
  kind: ScannedKind;
  /** The text a person reads (a block's visible text) or hears (an accessible name). */
  text: string;
  /** A short CSS path to the element, anchored at the nearest `data-testid`. */
  selector: string;
}

export interface LiteralHit extends ScannedNode {
  /** The untranslated runs found in `text`. */
  words: string[];
}

export interface AllowedTerm {
  term: string;
  reason: string;
}

/** Terms that may appear unaccented, each with why. Matched as whole runs, case-sensitively. */
export const LITERAL_ALLOWLIST: readonly AllowedTerm[] = [
  { term: "OBS", reason: "product name in streaming setup help, never translated" },
  { term: "RTMP", reason: "protocol name (ingest URL scheme)" },
  { term: "RTMPS", reason: "protocol name (ingest URL scheme)" },
  { term: "HLS", reason: "protocol name (playback)" },
  { term: "SRT", reason: "protocol name (ingest)" },
  { term: "AGPL", reason: "license identifier (AGPL-3.0)" },
];

/**
 * Elements whose text is not ours to translate: code and command samples, the third-party ALTCHA
 * widget (its own strings, keyed by base language; there is no pseudo-locale for it), graphics,
 * and the stream credentials (secrets and URLs, also kept out of the report).
 */
export const SKIP_SELECTORS: readonly string[] = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "video",
  "code",
  "pre",
  "kbd",
  "samp",
  "altcha-widget",
  '[data-testid="stream-key"]',
  '[data-testid="stream-key-prefix"]',
  '[data-testid="stream-server-url"]',
];

const PLAIN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Every letter `pseudoLocalize` can produce, taken from the real function. */
export const PSEUDO_LETTERS: ReadonlySet<string> = new Set(
  // The accented letters are all single BMP code points (`pseudo.ts`), so splitting by unit is exact.
  pseudoLocalize(PLAIN)
    .split("")
    .filter((ch) => ch !== "[" && ch !== "]" && ch !== "~"),
);

const OPEN = "\u0001";
const CLOSE = "\u0002";
const INNERMOST = /\[([^[\]]*)\]/g;

function isPseudoSegment(content: string): boolean {
  if (content.trimEnd().endsWith("~")) return true;
  for (const ch of content) if (PSEUDO_LETTERS.has(ch)) return true;
  return false;
}

/** A pseudo segment's own text (accented letters, padding) blanked; interpolated ASCII kept. */
function blankPseudo(content: string): string {
  let out = "";
  for (const ch of content) out += PSEUDO_LETTERS.has(ch) || ch === "~" ? " " : ch;
  return out;
}

/**
 * Blank every pseudo-localized `[…~]` segment's brackets, accented letters and padding, innermost
 * first, so nested messages unwrap too. Whatever ASCII is left inside was interpolated: user
 * content, URLs and `Intl` text are removed before this, so English left there is a hard-coded
 * argument (`t("x", { label: "Settings" })`) and is checked like any other text. Brackets that
 * are not pseudo (`[beta]`) stay.
 */
export function stripPseudoSegments(text: string): string {
  let s = text;
  for (;;) {
    let changed = false;
    s = s.replace(INNERMOST, (_m, content: string) => {
      changed = true;
      return isPseudoSegment(content) ? ` ${blankPseudo(content)} ` : `${OPEN}${content}${CLOSE}`;
    });
    if (!changed) break;
  }
  return s.replaceAll(OPEN, "[").replaceAll(CLOSE, "]");
}

// URLs of any scheme, e-mail addresses, lower-case host names with a TLD, and localhost.
const URLISH = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?::\d+)?(?:\/\S*)?/g,
  /\blocalhost(?::\d+)?(?:\/\S*)?/gi,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NUMBER = /\d+(?:[.,  ']\d+)*/g;
const NUMBER_SOURCE = String.raw`\d+(?:[.,  ']\d+)*`;

/**
 * One regex matching any of `phrases` as a whole phrase (not inside a longer word), with every
 * number generalized (so "5 minutes ago" also matches "12 minutes ago") and any whitespace run
 * matching any other (ICU uses no-break spaces). Case-sensitive: `Intl` never renders "Next" or
 * "Today" on its own, so a hard-coded button label still shows.
 */
export function phrasePattern(phrases: Iterable<string>): RegExp | null {
  const sources = new Map<string, number>();
  for (const raw of phrases) {
    const phrase = raw.trim();
    if (!/\p{L}/u.test(phrase)) continue;
    const source = phrase
      .split(NUMBER)
      .map((part) =>
        part
          .split(/\s+/)
          .map(escapeRegExp)
          .join(String.raw`\s+`),
      )
      .join(NUMBER_SOURCE);
    sources.set(source, Math.max(sources.get(source) ?? 0, phrase.length));
  }
  if (sources.size === 0) return null;
  // Longest first, so "5 minutes ago" goes whole rather than leaving "ago".
  const ordered = [...sources].sort((a, b) => b[1] - a[1]).map(([source]) => source);
  return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${ordered.join("|")})(?![\p{L}\p{N}])`, "gu");
}

export interface LiteralOptions {
  /** Values the scenario created or read from the API (usernames, titles, messages, keys…). */
  userContent?: Iterable<string>;
  /** Phrases `Intl` renders for the locale (`intlPhrases`), removed as whole phrases. */
  intlPhrases?: Iterable<string>;
  allowlist?: readonly AllowedTerm[];
}

interface Prepared {
  userContent: RegExp | null;
  intl: RegExp | null;
  allowed: Set<string>;
}

function prepare(opts: LiteralOptions): Prepared {
  // Shorter values cannot hide a three-letter run, and would cut holes in real words.
  const values = [...new Set([...(opts.userContent ?? [])].map((v) => v.trim()).filter((v) => v.length >= 3))];
  // Longest first, so a message that contains a username is removed whole.
  values.sort((a, b) => b.length - a.length);
  return {
    userContent: values.length > 0 ? new RegExp(values.map(escapeRegExp).join("|"), "gi") : null,
    intl: phrasePattern(opts.intlPhrases ?? []),
    allowed: new Set((opts.allowlist ?? LITERAL_ALLOWLIST).map((a) => a.term)),
  };
}

function wordsIn(text: string, p: Prepared): string[] {
  let s = p.userContent ? text.replace(p.userContent, " ") : text;
  for (const re of URLISH) s = s.replace(re, " ");
  if (p.intl) s = s.replace(p.intl, " ");
  s = stripPseudoSegments(s);
  const runs = s.match(/[A-Za-z]{3,}/g) ?? [];
  return runs.filter((w) => !p.allowed.has(w));
}

/** The untranslated runs in one string (empty when it is clean). */
export function untranslatedWords(text: string, opts: LiteralOptions = {}): string[] {
  return wordsIn(text, prepare(opts));
}

/** Every node that still carries untranslated text. */
export function findLiterals(nodes: readonly ScannedNode[], opts: LiteralOptions = {}): LiteralHit[] {
  const p = prepare(opts);
  const hits: LiteralHit[] = [];
  for (const node of nodes) {
    const words = wordsIn(node.text, p);
    if (words.length > 0) hits.push({ ...node, words });
  }
  return hits;
}

export interface IntlPhraseSpec {
  locales: readonly string[];
  languages?: readonly string[];
}

/**
 * Phrases `Intl` renders for `locales` (dates in every style the UI uses, month and weekday names,
 * relative times, compact numbers, currencies, units, time zones), plus the names of `languages`
 * in each of `locales` and in their own language, first letter upper-cased as the switcher shows
 * them. Locale data from ICU, not catalog text, so `formatRelativeTime` under `en-XA` ("5 minutes
 * ago") is not an untranslated literal. Whole phrases, so a lone "Next" or "Today" still is.
 * Self-contained so it also runs in the page (`page.evaluate`), whose ICU rendered the text.
 */
export function intlPhrases({ locales, languages = [] }: IntlPhraseSpec): string[] {
  const out = new Set<string>();
  const attempt = (fn: () => string | undefined) => {
    try {
      const s = fn();
      if (s) out.add(s);
    } catch {
      // A locale or option this ICU does not know: nothing to add.
    }
  };
  const year = 2026;
  const dateOptions: Intl.DateTimeFormatOptions[] = [
    { month: "long" },
    { month: "short" },
    { month: "long", day: "numeric" },
    { month: "short", day: "numeric" },
    { month: "long", year: "numeric" },
    { month: "short", year: "numeric" },
    { month: "long", day: "numeric", year: "numeric" },
    { month: "short", day: "numeric", year: "numeric" },
    { weekday: "long" },
    { weekday: "short" },
    { weekday: "long", month: "long", day: "numeric" },
    { weekday: "short", month: "short", day: "numeric" },
    { hour: "numeric" },
    { hour: "numeric", minute: "2-digit" },
    { timeZoneName: "short" },
    { timeZoneName: "long" },
  ];
  for (const dateStyle of ["full", "long", "medium", "short", undefined] as const)
    for (const timeStyle of ["full", "long", "medium", "short", undefined] as const)
      if (dateStyle || timeStyle) dateOptions.push({ dateStyle, timeStyle });
  for (const locale of locales) {
    // Every month (on the 15th) and every weekday (4–10 January), morning and afternoon.
    const days = [
      ...Array.from({ length: 12 }, (_, m) => [m, 15] as const),
      ...Array.from({ length: 7 }, (_, i) => [0, 4 + i] as const),
    ];
    for (const [month, day] of days)
      for (const hour of [3, 15]) {
        const d = new Date(Date.UTC(year, month, day, hour));
        for (const o of dateOptions)
          attempt(() => new Intl.DateTimeFormat(locale, { ...o, timeZone: "UTC" }).format(d));
      }
    const units = ["second", "minute", "hour", "day", "week", "month", "quarter", "year"] as const;
    for (const style of ["long", "short", "narrow"] as const)
      for (const numeric of ["always", "auto"] as const)
        for (const unit of units)
          for (const n of [-2, -1, 0, 1, 2])
            attempt(() => new Intl.RelativeTimeFormat(locale, { style, numeric }).format(n, unit));
    for (const compactDisplay of ["short", "long"] as const)
      for (const n of [1, 1e3, 1e6, 1e9, 1e12])
        attempt(() => new Intl.NumberFormat(locale, { notation: "compact", compactDisplay }).format(n));
    for (const currency of ["USD", "EUR", "GBP", "CAD", "AUD", "JPY", "MXN"])
      for (const currencyDisplay of ["symbol", "narrowSymbol", "code", "name"] as const)
        for (const n of [1, 2])
          attempt(() => new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay }).format(n));
    const measures = [
      "bit",
      "byte",
      "kilobit",
      "kilobyte",
      "megabit",
      "megabyte",
      "gigabit",
      "gigabyte",
      "terabyte",
      "kilobit-per-second",
      "megabit-per-second",
      "millisecond",
      "second",
      "minute",
      "hour",
      "day",
      "week",
      "month",
      "year",
      "percent",
    ];
    for (const unitDisplay of ["long", "short", "narrow"] as const)
      for (const unit of measures)
        for (const n of [1, 2])
          attempt(() => new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay }).format(n));
  }
  for (const tag of [...locales, ...languages])
    for (const display of [...locales, tag])
      attempt(() => {
        const name = new Intl.DisplayNames([display], { type: "language" }).of(tag);
        if (!name) return undefined;
        out.add(name);
        const [first = "", ...rest] = Array.from(name);
        return first.toLocaleUpperCase(display) + rest.join("");
      });
  return [...out];
}

/** Collect a page's visible text (grouped by block) and accessible names. Runs in the page. */
function collectInPage(skip: string): ScannedNode[] {
  const out: ScannedNode[] = [];
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && cur !== document.documentElement && depth < 6; depth++) {
      const id = cur.getAttribute("data-testid");
      if (id) {
        parts.unshift(`[data-testid="${id}"]`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      let nth = 1;
      if (parent)
        for (const sib of Array.from(parent.children)) {
          if (sib === cur) break;
          if (sib.tagName === cur.tagName) nth++;
        }
      parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nth})`);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const visible = (el: Element): boolean => {
    if (typeof el.checkVisibility === "function" && !el.checkVisibility()) return false;
    return getComputedStyle(el).visibility !== "hidden";
  };
  const isBlock = (el: Element): boolean => {
    const d = getComputedStyle(el).display;
    return !(d.startsWith("inline") || d === "contents");
  };
  const blocks = new Map<Element, string[]>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    const text = n.textContent ?? "";
    if (!parent || text.trim() === "" || parent.closest(skip) || !visible(parent)) continue;
    let block: Element = parent;
    while (block !== document.body && block.parentElement && !isBlock(block)) block = block.parentElement;
    const list = blocks.get(block) ?? [];
    list.push(text);
    blocks.set(block, list);
  }
  for (const [block, texts] of blocks) {
    // Joined with a space: inline neighbours ("alice@x.test" then "Settings") must not fuse.
    const text = texts.join(" ").replace(/\s+/g, " ").trim();
    if (text) out.push({ kind: "text", text, selector: pathOf(block) });
  }
  const attrs = [
    "aria-label",
    "aria-description",
    "aria-roledescription",
    "aria-valuetext",
    "placeholder",
    "alt",
    "title",
  ] as const;
  const query = [...attrs.map((a) => `[${a}]`), 'input[type="submit"][value]', 'input[type="button"][value]'].join(",");
  for (const el of Array.from(document.body.querySelectorAll(query))) {
    if (el.closest(skip) || el.closest('[aria-hidden="true"],[hidden],[inert]')) continue;
    if (!visible(el) && !(el instanceof HTMLInputElement)) continue;
    for (const a of attrs) {
      const v = el.getAttribute(a)?.trim();
      if (v) out.push({ kind: a, text: v, selector: pathOf(el) });
    }
    if (el instanceof HTMLInputElement && (el.type === "submit" || el.type === "button") && el.value.trim())
      out.push({ kind: "value", text: el.value.trim(), selector: pathOf(el) });
  }
  if (document.title.trim()) out.push({ kind: "document-title", text: document.title.trim(), selector: "title" });
  return out;
}

export interface PageScanOptions {
  userContent?: Iterable<string>;
  /** Locales whose `Intl` phrases are not literals (default `en-XA` and `en`). */
  intlLocales?: readonly string[];
  /** Languages a switcher may name, by their `Intl` display names (default `en`, `es`). */
  languages?: readonly string[];
  allowlist?: readonly AllowedTerm[];
}

export interface PageScan {
  hits: LiteralHit[];
  /** How many strings were scanned. */
  scanned: number;
}

const DEFAULT_INTL_LOCALES = ["en-XA", "en"];
const DEFAULT_LANGUAGES = ["en", "es"];

/** Scan the page as it is now. */
export async function scanPage(page: Page, opts: PageScanOptions = {}): Promise<PageScan> {
  const locales = [...(opts.intlLocales ?? DEFAULT_INTL_LOCALES)];
  const nodes = await page.evaluate(collectInPage, SKIP_SELECTORS.join(","));
  // Server-rendered text used the server's ICU, hydrated text the browser's: allow both.
  const languages = [...(opts.languages ?? DEFAULT_LANGUAGES)];
  // Passed by reference, not wrapped: Playwright serializes the function itself into the page.
  const pagePhrases = await page.evaluate(intlPhrases, { locales, languages });
  const phrases = new Set([...intlPhrases({ locales, languages }), ...pagePhrases]);
  const hits = findLiterals(nodes, {
    userContent: opts.userContent ?? [],
    intlPhrases: phrases,
    allowlist: opts.allowlist ?? LITERAL_ALLOWLIST,
  });
  return { hits, scanned: nodes.length };
}
