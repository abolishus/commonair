// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay receipt cross-check. A relay's signed receipt says how many bytes it served;
 * the origin's issuance log (`relay_issuance`) says how many bytes it could
 * legitimately have served for the tokens issued to it. Only verified bytes count
 * toward patronage.
 */

/** Float slack so a receipt exactly at the tolerance (e.g. 1100 of 1000 at 10 %) counts as within it. */
export const RATIO_EPSILON = 1e-9;

export type ReceiptCheck =
  | { status: "verified"; bytesVerified: number; overReportRatio: number }
  | {
      status: "rejected";
      bytesVerified: 0;
      /** reported / issued − 1; null when nothing was issued (ratio undefined). */
      overReportRatio: number | null;
      reason: "over_report" | "no_issuance";
    };

/**
 * Within tolerance, the receipt is verified for min(reported, issued) bytes (a relay is
 * never paid for more than was issued). Beyond tolerance, or bytes reported against no
 * issuance at all, it is rejected.
 */
export function checkReceipt(bytesReported: number, bytesIssued: number | null, tolerance: number): ReceiptCheck {
  const reported = Math.max(0, bytesReported);
  const issued = Math.max(0, bytesIssued ?? 0);
  if (reported === 0) return { status: "verified", bytesVerified: 0, overReportRatio: issued > 0 ? -1 : 0 };
  if (issued === 0) return { status: "rejected", bytesVerified: 0, overReportRatio: null, reason: "no_issuance" };
  const ratio = reported / issued - 1;
  if (ratio > tolerance + RATIO_EPSILON)
    return { status: "rejected", bytesVerified: 0, overReportRatio: ratio, reason: "over_report" };
  return { status: "verified", bytesVerified: Math.min(reported, issued), overReportRatio: ratio };
}

export interface ReceiptHistoryEntry {
  periodEnd: Date;
  status: "verified" | "rejected";
  overReportRatio: number | null;
}

export interface RelayStanding {
  suspend: boolean;
  reason: "repeated_over_report" | "gross_over_report" | null;
  /** Over-reporting periods among the last 5 checked. */
  overReportingPeriods: number;
  periodsConsidered: number;
  worstRatio: number | null;
}

export const STANDING_WINDOW = 5;
export const STANDING_REPEAT = 2;
export const GROSS_MULTIPLE = 3;

/**
 * Suspend when the relay over-reported beyond tolerance in at least 2 of its last 5
 * checked periods, or in any single period by more than 3 × the tolerance. A receipt
 * reporting bytes against no issuance counts as an unbounded over-report.
 */
export function relayStanding(history: readonly ReceiptHistoryEntry[], tolerance: number): RelayStanding {
  const recent = [...history].sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime()).slice(0, STANDING_WINDOW);
  const ratios = recent.map((h) =>
    h.overReportRatio === null ? (h.status === "rejected" ? Number.POSITIVE_INFINITY : 0) : h.overReportRatio,
  );
  const over = ratios.filter((r) => r > tolerance + RATIO_EPSILON).length;
  const worst = ratios.length ? Math.max(...ratios) : null;
  const gross = worst !== null && worst > tolerance * GROSS_MULTIPLE + RATIO_EPSILON;
  const repeated = over >= STANDING_REPEAT;
  return {
    suspend: gross || repeated,
    reason: gross ? "gross_over_report" : repeated ? "repeated_over_report" : null,
    overReportingPeriods: over,
    periodsConsidered: recent.length,
    worstRatio: worst === null || Number.isFinite(worst) ? worst : null,
  };
}
