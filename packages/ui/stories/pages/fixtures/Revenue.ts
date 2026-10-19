// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sample data from the Revenue board (October 2026). Money is integer cents, USD. */
import type { StatusTone } from "@commonair/ui";
import type { BreakdownSegment } from "@commonair/ui/blocks/data";

export const months = [
  { value: "2026-10", label: "October 2026" },
  { value: "2026-09", label: "September 2026" },
];

export const balances = {
  available: { cents: 128_460, hint: "Pays out Nov 1 · minimum $50.00" },
  earned: { cents: 84_210, delta: "+14% vs September" },
  patronage: { cents: 9_640, hint: "Paid yearly to members." },
};

export const bySource: BreakdownSegment[] = [
  { id: "subs", label: "Subscriptions", value: 53_894, color: "--chart-1" },
  { id: "tips", label: "Tips", value: 18_526, color: "--chart-2" },
  { id: "gifts", label: "Gift subscriptions", value: 11_790, color: "--chart-3" },
];

export const subscribers = {
  total: "152",
  tiers: [
    { id: "t1", tier: "Tier 1", subs: 118, share: 41_806 },
    { id: "t2", tier: "Tier 2", subs: 27, share: 19_152 },
    { id: "t3", tier: "Tier 3", subs: 7, share: 12_421 },
  ],
};

export interface LedgerRow {
  id: string;
  date: string;
  type: string;
  tone: StatusTone;
  from: string;
  gross: number | null;
  fees: number | null;
  net: number;
}

export const ledger: LedgerRow[] = [
  { id: "l1", date: "Oct 17", type: "Tip", tone: "success", from: "Fernsby", gross: 500, fees: -75, net: 425 },
  {
    id: "l2",
    date: "Oct 17",
    type: "Gift ×5",
    tone: "accent",
    from: "paperlantern",
    gross: 2495,
    fees: -725,
    net: 1770,
  },
  { id: "l3", date: "Oct 17", type: "Sub T2", tone: "accent", from: "ohmslaw", gross: 999, fees: -290, net: 709 },
  { id: "l4", date: "Oct 16", type: "Refund", tone: "warning", from: "tapehead99", gross: -499, fees: 145, net: -354 },
  {
    id: "l5",
    date: "Oct 15",
    type: "Chargeback",
    tone: "danger",
    from: "payment dispute 8812",
    gross: -999,
    fees: 290,
    net: -709,
  },
  { id: "l6", date: "Oct 15", type: "Sub T1", tone: "accent", from: "quietfox", gross: 499, fees: -145, net: 354 },
  {
    id: "l7",
    date: "Oct 1",
    type: "Payout",
    tone: "neutral",
    from: "Bank ••••6021",
    gross: null,
    fees: null,
    net: -110_233,
  },
];

export const payout = [
  { id: "bank", title: "Bank transfer ••••6021", description: "Verified · USD" },
  { id: "tax", title: "Tax information", description: "W-9 on file · 2026" },
];
