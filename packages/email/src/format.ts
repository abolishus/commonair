// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatMessage, parseMessage, type MessageAst } from "@commonair/i18n";
import { Fragment, createElement, type ReactNode } from "react";

/** A date as a `Date` or an ISO 8601 string (the wire format). */
export type DateInput = Date | string;

const PLACEHOLDER = /\{(\w+)\}/g;

const asts = new Map<string, MessageAst | null>();

/** Parsed once per message; null when it does not parse (the catalog tests fail on that). */
function parsed(message: string): MessageAst | null {
  let ast = asts.get(message);
  if (ast === undefined) {
    try {
      ast = parseMessage(message);
    } catch {
      ast = null;
    }
    asts.set(message, ast);
  }
  return ast;
}

/** `en-XA` and tags `Intl` rejects use English rules, as `@commonair/i18n` does. */
function intlLocale(locale: string): string {
  if (locale === "en-XA") return "en";
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en";
  } catch {
    return "en";
  }
}

const has = (vars: Readonly<Record<string, unknown>>, name: string) =>
  Object.hasOwn(vars, name) && vars[name] !== undefined;

/**
 * Format a message in the ICU subset of ADR 0029 (`{name}`, `plural` with `#` formatted for
 * `locale`, `select`, `selectordinal`) with string values. Unknown placeholders stay visible
 * rather than dropped, so a broken translation is noticed, not silent. A message that does not
 * parse (never a bundled one: the tests check, and `mergeCatalog` replaces a broken translation
 * with English) only has its `{name}` placeholders filled.
 */
export function interpolate(message: string, vars: Record<string, string | number>, locale = "en"): string {
  const ast = parsed(message);
  if (ast) return formatMessage(ast, vars, intlLocale(locale));
  return message.replace(PLACEHOLDER, (whole, key: string) => (has(vars, key) ? String(vars[key]) : whole));
}

type Pound = { value: number } | { raw: string } | null;

function renderNodes(
  ast: MessageAst,
  vars: Record<string, ReactNode>,
  locale: string,
  pound: Pound,
  path: string,
): ReactNode[] {
  const out: ReactNode[] = [];
  ast.forEach((node, i) => {
    const key = `${path}${i}`;
    if (typeof node === "string") out.push(node);
    else if (node.type === "arg") {
      out.push(has(vars, node.name) ? createElement(Fragment, { key }, vars[node.name]) : `{${node.name}}`);
    } else if (node.type === "pound") {
      if (pound === null) out.push("#");
      else if ("value" in pound) out.push(new Intl.NumberFormat(locale).format(pound.value));
      else out.push(pound.raw);
    } else if (node.type === "select") {
      const value = vars[node.name];
      const selector = typeof value === "string" || typeof value === "number" ? String(value) : "other";
      const branch = (selector !== "other" && node.options.get(selector)) || node.options.get("other") || [];
      out.push(createElement(Fragment, { key }, renderNodes(branch, vars, locale, pound, `${key}.`)));
    } else {
      const value = vars[node.name];
      let branch: MessageAst;
      let inner: Pound;
      if (typeof value === "number" && Number.isFinite(value)) {
        const rules = new Intl.PluralRules(locale, { type: node.ordinal ? "ordinal" : "cardinal" });
        branch =
          node.options.get(`=${value}`) ??
          node.options.get(rules.select(value - node.offset)) ??
          node.options.get("other") ??
          [];
        inner = { value: value - node.offset };
      } else {
        // Not a number (a missing argument): `other`, and `#` shows what was given, as formatMessage does.
        branch = node.options.get("other") ?? [];
        inner = { raw: typeof value === "string" ? value : "" };
      }
      out.push(createElement(Fragment, { key }, renderNodes(branch, vars, locale, inner, `${key}.`)));
    }
  });
  return out;
}

/**
 * Like `interpolate`, but values may be React nodes (links, emphasis), also inside plural and
 * select branches. A plural's argument must be a number; `#` is formatted for `locale`.
 */
export function interpolateNodes(message: string, vars: Record<string, ReactNode>, locale = "en"): ReactNode {
  const ast = parsed(message);
  if (ast) return renderNodes(ast, vars, intlLocale(locale), null, "");
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of message.matchAll(PLACEHOLDER)) {
    const key = match[1] ?? "";
    const index = match.index;
    if (index > last) parts.push(message.slice(last, index));
    parts.push(has(vars, key) ? createElement(Fragment, { key: `${key}-${index}` }, vars[key]) : match[0]);
    last = index + match[0].length;
  }
  if (last < message.length) parts.push(message.slice(last));
  return parts;
}

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid date: ${String(value)}`);
  return date;
}

/** Locale-aware date and time in UTC (emails cannot know the reader's zone). */
export function formatDateTime(value: DateInput, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(toDate(value));
}

/** Locale-aware calendar date in UTC. */
export function formatDate(value: DateInput, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(toDate(value));
}

/** Integer minor units (cents) with an explicit ISO 4217 currency; never floats in, exact out. */
export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  if (!Number.isSafeInteger(amountMinor)) throw new TypeError("amount must be an integer number of minor units");
  const nf = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  return nf.format(amountMinor / 10 ** digits);
}

export function formatPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(ratio);
}

/** Strip CR/LF so user-provided text (titles, names) cannot break header lines. */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}
