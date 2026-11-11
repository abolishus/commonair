// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (overhaul D5.7, creator-studio CS-9): the revenue page's arithmetic, pure. The month's
 * figures as an equation that adds up exactly, the creator share as a percent from `platform.cut`
 * (never a hard-coded number), and ledger references with processor ids taken out.
 */
import { formatNumber } from "@commonair/ui";
import type { RevenueLineDto, RevenueSummaryDto } from "../../lib/money.ts";

export type EquationTerm = "gross" | "coopCut" | "refunds" | "other" | "net";

export interface EquationRow {
  term: EquationTerm;
  /** Signed as it applies: deductions are negative, so the rows above `net` sum to it. */
  cents: number;
}

/**
 * `gross − co-op share − refunds and chargebacks − other = net`, exact to the cent. "Other" is
 * whatever else the ledger took from gross before it reached the owner (tax, crew splits); it is
 * derived, so the equation always closes, and left out when it is zero.
 */
export function revenueEquation(s: Pick<RevenueSummaryDto, "gross" | "coopCut" | "refundsAndChargebacks" | "net">): {
  rows: EquationRow[];
  currency: string;
} {
  const other = s.gross.cents - s.coopCut.cents - s.refundsAndChargebacks.cents - s.net.cents;
  const rows: EquationRow[] = [
    { term: "gross", cents: s.gross.cents },
    { term: "coopCut", cents: -s.coopCut.cents },
    { term: "refunds", cents: -s.refundsAndChargebacks.cents },
    ...(other !== 0 ? [{ term: "other" as const, cents: -other }] : []),
    { term: "net", cents: s.net.cents },
  ];
  return { rows, currency: s.net.currency };
}

/** True when the rows above `net` add up to it (always, by construction; the tests hold us to it). */
export function equationCloses(rows: readonly EquationRow[]): boolean {
  const net = rows.find((r) => r.term === "net");
  if (!net) return false;
  return rows.filter((r) => r.term !== "net").reduce((sum, r) => sum + r.cents, 0) === net.cents;
}

/** A share (0.9) as a localized percent number without the sign ("90", "87.5"). */
export function sharePercent(share: number, locale: string): string {
  return formatNumber(Math.round(share * 1000) / 10, locale);
}

/** Payment-processor object ids (`pi_…`, `ch_…`, `tr_…`, `po_…`, `cs_test_…`): never shown in the studio. */
const PROCESSOR_ID = /^[a-z]{2,6}_[A-Za-z0-9_]{6,}$/;
export const isProcessorId = (ref: string): boolean => PROCESSOR_ID.test(ref);

/** Longest reference shown in full; longer ones keep their end, which is what people match on. */
const SHORT_REFERENCE = 14;

export type LedgerReference = { kind: "card" } | { kind: "ref"; text: string } | null;

/**
 * What a ledger line says about its reference: a card payment says so (its processor id stays in
 * the breakdown), a bank-transfer or payout reference shows short, a processor payout id shows
 * nothing.
 */
export function ledgerReference(line: Pick<RevenueLineDto, "type" | "reference">): LedgerReference {
  const ref = line.reference?.trim() ?? "";
  if (ref === "") return null;
  if (isProcessorId(ref)) return line.type === "payout" ? null : { kind: "card" };
  return { kind: "ref", text: ref.length > SHORT_REFERENCE ? `…${ref.slice(-(SHORT_REFERENCE - 1))}` : ref };
}
