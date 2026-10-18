// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Human-readable statement lines. The text is a pure function of the line's numbers and a
 * formatter, so the web can re-render any stored line in the reader's language by passing
 * its own formatter; the English formatter is used for the stored text.
 */
import type { PATRONAGE_COMPONENTS, PatronageLine } from "@commonair/contracts/shapes";

export type PatronageComponent = (typeof PATRONAGE_COMPONENTS)[number];

export interface PatronageFormatter {
  /** Component label, e.g. "Revenue". */
  component(c: PatronageComponent): string;
  money(cents: number): string;
  /** A member's contribution in the component's unit (cents, hours, bytes). */
  value(c: PatronageComponent, value: number): string;
  percent(fraction: number): string;
  /** Sentence templates; override all of them to localize. */
  templates: {
    contribution(p: {
      label: string;
      member: string;
      total: string;
      share: string;
      amount: string;
      pool: string;
    }): string;
    capped(p: { cap: string }): string;
    emptyPool(p: { label: string; pool: string }): string;
    capOverflow(p: { label: string; amount: string; pool: string; viewerLabel: string }): string;
  };
}

export function englishFormatter(currency: string): PatronageFormatter {
  const money = new Intl.NumberFormat("en", { style: "currency", currency: currency.toUpperCase() });
  const num = new Intl.NumberFormat("en", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const pct = new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const labels: Record<PatronageComponent, string> = {
    revenue: "Revenue",
    streamingHours: "Streaming hours",
    relayBandwidth: "Relay bandwidth",
    viewerHours: "Viewer-hours",
    adjustment: "Adjustment",
  };
  return {
    component: (c) => labels[c],
    money: (cents) => money.format(cents / 100),
    value(c, v) {
      if (c === "revenue") return money.format(v / 100);
      if (c === "relayBandwidth") return `${num.format(v / 1e9)} GB`;
      return `${num.format(v)} h`;
    },
    percent: (f) => pct.format(f),
    templates: {
      contribution: (p) => `${p.label}: ${p.member} of ${p.total} (${p.share}) of the ${p.pool} pool = ${p.amount}`,
      capped: (p) => ` (capped at ${p.cap} of the pool)`,
      emptyPool: (p) => `${p.label}: no eligible contributions this period; the ${p.pool} pool is retained as surplus`,
      capOverflow: (p) =>
        `${p.label}: ${p.amount} of the ${p.pool} ${p.viewerLabel} pool is retained because every channel reached the cap`,
    },
  };
}

export type LineNumbers = Omit<PatronageLine, "explanation">;

/** The explanation for a statement line. */
export function explainLine(line: LineNumbers, fmt: PatronageFormatter): string {
  const label = fmt.component(line.component);
  if (line.component === "adjustment") {
    return fmt.templates.capOverflow({
      label,
      amount: fmt.money(line.amountCents),
      pool: fmt.money(line.poolCents),
      viewerLabel: fmt.component("viewerHours"),
    });
  }
  if (line.poolTotal === 0) return fmt.templates.emptyPool({ label, pool: fmt.money(line.poolCents) });
  const text = fmt.templates.contribution({
    label,
    member: fmt.value(line.component, line.memberValue),
    total: fmt.value(line.component, line.poolTotal),
    share: fmt.percent(line.share),
    amount: fmt.money(line.amountCents),
    pool: fmt.money(line.poolCents),
  });
  if (!line.capApplied || line.poolCents === 0) return text;
  return text + fmt.templates.capped({ cap: fmt.percent(line.amountCents / line.poolCents) });
}
