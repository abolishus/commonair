// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sample data from the Finances board (platform finances). Money is integer cents, USD, rendered
 * with MoneyAmount/formatMoney; only sub-cent unit costs are text. The monthly chart is in whole
 * thousands of dollars (axis values, not amounts).
 */
import type { ProgressTone } from "@commonair/ui/blocks/data";
import type { Figure, Money, MoneyNote } from "../money.tsx";

export const tabs = [
  { id: "overview", label: "Overview", href: "#finances", current: true },
  { id: "expenses", label: "Service expenses", href: "#finances/expenses" },
  { id: "patronage", label: "Patronage", href: "#transparency" },
];

export const intro =
  "What it costs to run CommonAir and where the money to pay for it comes from. Rebuilt every night from the append-only ledger. Public, no sign-in needed. Every figure links to the journal entries behind it.";

export type Period = "month" | "quarter" | "year";

export const periods: { value: Period; label: string }[] = [
  { value: "month", label: "October (to date)" },
  { value: "quarter", label: "Q3 2026" },
  { value: "year", label: "Last 12 months" },
];

export const ledgerClosed = "Ledger closed through Oct 17 · 23:59 UTC";

export interface Kpi {
  label: string;
  value: Figure;
  note: string | MoneyNote;
  up?: boolean;
}

// Cost per viewer-hour is a fraction of a cent: kept as text (see `money.tsx`).
export const kpis: Record<Period, Kpi[]> = {
  month: [
    { label: "Platform income", value: { cents: 2_110_000 }, note: "Oct 1–17" },
    { label: "Operating expenses", value: { cents: 1_438_000 }, note: "Oct 1–17" },
    {
      label: "Net surplus",
      value: { cents: 672_000, signed: true },
      note: { money: { cents: 114_000, signed: true }, after: " vs same days in Sep" },
      up: true,
    },
    { label: "Reserve", value: { cents: 10_130_000 }, note: "4.2 months of runway" },
    { label: "Cost per viewer-hour", value: { subCent: "$0.0061" }, note: "−9% since relays", up: true },
    { label: "Cost per streamed hour", value: { cents: 42 }, note: "transcode + ingest" },
  ],
  quarter: [
    { label: "Platform income", value: { cents: 10_304_000 }, note: "Q3 2026" },
    { label: "Operating expenses", value: { cents: 7_140_000 }, note: "Q3 2026" },
    { label: "Net surplus", value: { cents: 3_164_000, signed: true }, note: "+18% vs Q2", up: true },
    { label: "Reserve", value: { cents: 9_410_000 }, note: "at Sep 30" },
    { label: "Cost per viewer-hour", value: { subCent: "$0.0067" }, note: "Q3 average" },
    { label: "Cost per streamed hour", value: { cents: 44 }, note: "Q3 average" },
  ],
  year: [
    { label: "Platform income", value: { cents: 29_860_000 }, note: "Nov 2025 – Oct 2026" },
    { label: "Operating expenses", value: { cents: 25_190_000 }, note: "Nov 2025 – Oct 2026" },
    { label: "Net surplus", value: { cents: 4_670_000, signed: true }, note: "first surplus year", up: true },
    {
      label: "Reserve",
      value: { cents: 10_130_000 },
      note: { before: "from ", money: { cents: 5_460_000 } },
      up: true,
    },
    { label: "Cost per viewer-hour", value: { subCent: "$0.0081" }, note: "12-month average" },
    { label: "Cost per streamed hour", value: { cents: 51 }, note: "12-month average" },
  ],
};

export const periodLabels: Record<Period, string> = {
  month: "October 1–17, 2026",
  quarter: "Q3 2026 (figures below shown for October to date)",
  year: "Last 12 months (figures below shown for October to date)",
};

const labels = ["Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"];
const income = [14, 16, 17, 19, 21, 23, 25, 26, 28, 30, 31, 33];
const expenses = [17, 18, 18, 19, 19, 20, 21, 21, 22, 23, 24, 24];
/** Thousands of dollars per month. */
export const monthly = labels.map((month, i) => ({ month, income: income[i] ?? 0, expenses: expenses[i] ?? 0 }));

export interface StatementRow {
  id: string;
  group: string;
  line: string;
  cents: number | null;
  share: string;
  source?: { label: string; href: string };
}

let row = 0;
const line = (
  group: string,
  label: string,
  cents: number | null,
  share: string,
  source?: StatementRow["source"],
): StatementRow => ({
  id: `l${++row}`,
  group,
  line: label,
  cents,
  share,
  source,
});

export const statement: StatementRow[] = [
  line("Money in", "Subscriptions (gross)", 5_894_000, "70.0%", { label: "212 entries", href: "#ledger/subs" }),
  line("Money in", "Gift subscriptions", 987_000, "11.7%", { label: "48 entries", href: "#ledger/gifts" }),
  line("Money in", "Tips", 1_315_000, "15.6%", { label: "1,904 entries", href: "#ledger/tips" }),
  line("Money in", "Direct donations to the co-op", 225_000, "2.7%", {
    label: "31 entries",
    href: "#ledger/donations",
  }),
  line("Money in", "Gross receipts", 8_421_000, "100%"),
  line("Passed through", "Paid to creators", -5_910_000, "70.2%", { label: "per channel", href: "#revenue" }),
  line("Passed through", "Payment processing fees", -401_000, "4.8%", { label: "rates", href: "#finances/expenses" }),
  line("Passed through", "Platform income", 2_110_000, "25.1%"),
  line("Operating expenses", "Compute & servers", -412_000, "4.9%", {
    label: "6 services",
    href: "#finances/expenses",
  }),
  line("Operating expenses", "Bandwidth & storage", -224_000, "2.7%", {
    label: "4 services",
    href: "#finances/expenses",
  }),
  line("Operating expenses", "Worker-member wages", -580_000, "6.9%", { label: "4.5 FTE", href: "#finances/expenses" }),
  line("Operating expenses", "Trust & safety contractors", -91_000, "1.1%", {
    label: "2 contracts",
    href: "#finances/expenses",
  }),
  line("Operating expenses", "Legal, accounting & insurance", -76_000, "0.9%", {
    label: "3 firms",
    href: "#finances/expenses",
  }),
  line("Operating expenses", "Upstream FOSS donations", -35_000, "0.4%", {
    label: "9 projects",
    href: "#finances/expenses",
  }),
  line("Operating expenses", "Everything else", -20_000, "0.2%", { label: "5 lines", href: "#finances/expenses" }),
  line("Operating expenses", "Total operating expenses", -1_438_000, "17.1%"),
  line("Result", "Net surplus", 672_000, "8.0%"),
  line("Result", "→ to reserve (policy: 50% until 6 months of runway)", 336_000, ""),
  line("Result", "→ to patronage pool", 336_000, "", { label: "formula", href: "#transparency" }),
];

export const budget: {
  label: string;
  actual: Money;
  target: Money;
  percent: number;
  note: string | MoneyNote;
  tone: ProgressTone;
}[] = [
  {
    label: "Infrastructure",
    actual: { cents: 6_120_000 },
    target: { cents: 8_000_000 },
    percent: 77,
    note: "On track (83% of year elapsed)",
    tone: "default",
  },
  {
    label: "Wages",
    actual: { cents: 5_800_000 },
    target: { cents: 7_200_000 },
    percent: 81,
    note: "On track",
    tone: "default",
  },
  {
    label: "Trust & safety",
    actual: { cents: 1_160_000 },
    target: { cents: 1_200_000 },
    percent: 97,
    note: { before: "Over pace — council approved ", money: { cents: 200_000, signed: true }, after: " on Sep 9" },
    tone: "danger",
  },
  {
    label: "Legal & accounting",
    actual: { cents: 710_000 },
    target: { cents: 1_000_000 },
    percent: 71,
    note: "Annual audit still to come",
    tone: "default",
  },
  {
    label: "FOSS donations",
    actual: { cents: 350_000 },
    target: { cents: 420_000 },
    percent: 83,
    note: "On track",
    tone: "default",
  },
];

export const reserves = {
  amount: { cents: 10_130_000 } as Money,
  months: "4.2 months of operating cost",
  percent: 70,
  target: { before: "target 6 months · ", money: { cents: 14_460_000 } } as MoneyNote,
  note: {
    before:
      "Held in a member-controlled operating account and a short-term treasury fund. Two signers required for any transfer over ",
    money: { cents: 500_000 },
    after: ".",
  } as MoneyNote,
};

export const queries = {
  text: "Any member can open a query on any line. The treasurer answers in public within 7 days.",
  counts: "14 open · 212 answered",
};
