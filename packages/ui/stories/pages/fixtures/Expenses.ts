// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sample data from the Expenses board (service expenses). Money is integer cents, USD, rendered
 * with MoneyAmount/formatMoney. Sub-cent unit costs (per viewer-hour, per 1,000 viewer-hours) are
 * text because they cannot be expressed in cents (see `money.tsx`).
 */
import type { BreakdownSegment } from "@commonair/ui/blocks/data";
import type { Money, MoneyNote, SubCent } from "../money.tsx";

export const tabs = [
  { id: "overview", label: "Overview", href: "#finances" },
  { id: "expenses", label: "Service expenses", href: "#finances/expenses", current: true },
  { id: "patronage", label: "Patronage", href: "#transparency" },
];

export const intro =
  "Every service we pay for, what it runs, how it bills and what it cost. Every invoice is attached. Wages are shown by role and pay band; names are never published.";

export const stats: { label: string; value: Money | { count: string }; hint?: string; delta?: string }[] = [
  { label: "Monthly run rate", value: { cents: 2_410_000 }, hint: "trailing 30 days" },
  { label: "Paid services", value: { count: "17" }, hint: "from 11 vendors" },
  { label: "Software licenses", value: { cents: 0 }, hint: "the whole stack is FOSS" },
  { label: "Saved by community relays", value: { cents: 318_000 }, delta: "per month, est. at our transit rate" },
];

export const runRate: BreakdownSegment[] = [
  { id: "wages", label: "Wages", value: 40, color: "--chart-4" },
  { id: "compute", label: "Compute", value: 29, color: "--chart-1" },
  { id: "bandwidth", label: "Bandwidth & storage", value: 16, color: "--chart-5" },
  { id: "safety", label: "Trust & safety", value: 6, color: "--chart-3" },
  { id: "legal", label: "Legal & accounting", value: 5, color: "--chart-6" },
  { id: "foss", label: "FOSS donations", value: 2, color: "--chart-2" },
  { id: "other", label: "Other", value: 2, color: "--chart-8" },
];

export type CostBasis = "month" | "unit";
export const costBases: { value: CostBasis; label: string }[] = [
  { value: "month", label: "Per month" },
  { value: "unit", label: "Per 1,000 viewer-hours" },
];

export interface Service {
  id: string;
  name: string;
  runs: string;
  billing: string;
  usage: string;
  /** Null when the service is billed flat with no unit. */
  unitPrice: Money | null;
  monthlyCents: number;
  delta: string;
  /** Cost per 1,000 verified viewer-hours (monthly cost / 3,950K viewer-hours): sub-cent, so text. */
  unitCost: string;
}

export const services: Service[] = (
  [
    [
      "Bare-metal servers (EU)",
      "origin, API, chat, Postgres",
      "flat, per server",
      "6 servers",
      30_667,
      184_000,
      "0%",
      "$0.466",
    ],
    [
      "Bare-metal servers (US)",
      "edge cache, chat replica",
      "flat, per server",
      "4 servers",
      29_000,
      116_000,
      "0%",
      "$0.294",
    ],
    ["GPU transcoding nodes", "adaptive renditions (NVENC)", "per hour used", "2,710 h", 30, 81_300, "+6%", "$0.206"],
    ["Cloud burst compute", "overflow transcoding", "per hour used", "412 h", 74, 30_500, "−22%", "$0.077"],
    [
      "Transit bandwidth",
      "video egress not served by relays",
      "per TB over commit",
      "512 TB",
      280,
      143_400,
      "−11%",
      "$0.363",
    ],
    ["Object storage", "VODs, clips, thumbnails, backups", "per TB-month", "96 TB", 600, 57_600, "+4%", "$0.146"],
    ["Backup storage (offsite)", "WAL archives, nightly dumps", "per TB-month", "18 TB", 500, 9_000, "+2%", "$0.023"],
    [
      "Transactional email",
      "verification, go-live, statements",
      "per 1,000 emails",
      "214K",
      65,
      13_900,
      "+9%",
      "$0.035",
    ],
    ["DNS, domains & TLS", "name service, certificates", "flat", "—", null, 2_400, "0%", "$0.006"],
    ["Status page host", "separate infra for status", "flat", "1 server", 1_200, 1_200, "0%", "$0.003"],
  ] as const
).map(([name, runs, billing, usage, unitPrice, monthlyCents, delta, unitCost], index) => ({
  id: `s${index}`,
  name,
  runs,
  billing,
  usage,
  unitPrice: unitPrice === null ? null : { cents: unitPrice },
  monthlyCents,
  delta,
  unitCost,
}));

export const servicesNote = {
  before: "Payment processing is charged per transaction and shown on the overview as a pass-through: 2.9% + ",
  fee: { cents: 30 } as Money,
  middle: " per payment, or ",
  manual: { cents: 0 } as Money,
  after: " on the manual adapter.",
};

export const viewerHour = {
  // Sub-cent amounts: text until formatMoney supports sub-minor-unit precision.
  total: { subCent: "$0.0061" } as SubCent,
  // Per viewer-hour shares are sub-cent too.
  parts: [
    { label: "Video egress (origin + edge)", value: "$0.0029", percent: 48 },
    { label: "Transcoding", value: "$0.0016", percent: 26 },
    { label: "Storage (VOD, clips)", value: "$0.0007", percent: 11 },
    { label: "Chat & API", value: "$0.0005", percent: 8 },
    { label: "Trust & safety review", value: "$0.0004", percent: 7 },
  ],
  streamedHour: { before: "One streamed hour (ingest + 4 renditions + archive): ", money: { cents: 42 } } as MoneyNote,
};

export const invoices = [
  {
    id: "i1",
    date: "Oct 15",
    title: "Transit bandwidth · September overage",
    cents: 161_240,
    approvedBy: "treasurer + infra lead",
  },
  { id: "i2", date: "Oct 10", title: "GPU transcoding nodes · September", cents: 76_820, approvedBy: "treasurer" },
  {
    id: "i3",
    date: "Oct 3",
    title: "Trust & safety contractor A · September",
    cents: 48_000,
    approvedBy: "treasurer + T&S lead",
  },
  { id: "i4", date: "Oct 1", title: "Bare-metal servers (EU) · October", cents: 184_000, approvedBy: "treasurer" },
  { id: "i5", date: "Oct 1", title: "Bare-metal servers (US) · October", cents: 116_000, approvedBy: "treasurer" },
  {
    id: "i6",
    date: "Sep 30",
    title: "Accounting firm · Q3 bookkeeping",
    cents: 135_000,
    approvedBy: "treasurer + council chair",
  },
];

/** Annual pay bands; the total row is the monthly wage bill. */
export const wages: { id: string; role: string; fte: string; band: Money; perMonth?: boolean }[] = [
  { id: "infra", role: "Infrastructure engineer", fte: "1.5", band: { cents: 6_400_000 } },
  { id: "platform", role: "Platform engineer", fte: "1.0", band: { cents: 6_400_000 } },
  { id: "safety", role: "Trust & safety lead", fte: "1.0", band: { cents: 5_800_000 } },
  { id: "treasurer", role: "Treasurer & operations", fte: "0.5", band: { cents: 5_800_000 } },
  { id: "community", role: "Community & support", fte: "0.5", band: { cents: 4_800_000 } },
  { id: "total", role: "Total", fte: "4.5", band: { cents: 580_000 }, perMonth: true },
];
export const payRatio = "Current ratio 1.33 : 1";

export const commitments: { id: string; title: string; detail: string; amount: Money; perMonth?: boolean }[] = [
  {
    id: "c1",
    title: "Bare-metal servers, EU",
    detail: "12-month term · renews Mar 1, 2027",
    amount: { cents: 184_000 },
    perMonth: true,
  },
  {
    id: "c2",
    title: "Transit bandwidth",
    detail: "committed 400 TB/mo · month to month",
    amount: { cents: 112_000 },
    perMonth: true,
  },
  { id: "c3", title: "Annual audit", detail: "engagement letter signed · due Feb 2027", amount: { cents: 480_000 } },
];

export const foss = [
  { term: "Video server", cents: 9_000 },
  { term: "Database", cents: 7_000 },
  { term: "JavaScript runtime", cents: 6_000 },
  { term: "Encoder libraries", cents: 6_000 },
  { term: "5 more projects", cents: 7_000 },
];
