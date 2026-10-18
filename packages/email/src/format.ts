// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Fragment, createElement, type ReactNode } from "react";

/** A date as a `Date` or an ISO 8601 string (the wire format). */
export type DateInput = Date | string;

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Fill `{name}` placeholders with plain strings. Unknown placeholders are left
 * visible rather than dropped, so a broken translation is noticed, not silent.
 */
export function interpolate(message: string, vars: Record<string, string | number>): string {
  return message.replace(PLACEHOLDER, (whole, key: string) => (Object.hasOwn(vars, key) ? String(vars[key]) : whole));
}

/** Like `interpolate`, but values may be React nodes (links, emphasis). */
export function interpolateNodes(message: string, vars: Record<string, ReactNode>): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of message.matchAll(PLACEHOLDER)) {
    const key = match[1] ?? "";
    const index = match.index;
    if (index > last) parts.push(message.slice(last, index));
    parts.push(Object.hasOwn(vars, key) ? createElement(Fragment, { key: `${key}-${index}` }, vars[key]) : match[0]);
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
