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
  | {
      status: "verified";
      bytesVerified: number;
      /** reported / issued − 1; null when issuance was unknown (ratio not meaningful). */
      overReportRatio: number | null;
      /** "unknown" when the origin's issuance record has gaps for this period. */
      issuance: "complete" | "unknown";
    }
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
 *
 * `issuanceComplete` is false when the origin's record is missing for minutes in which the
 * relay had live sessions (an origin restart, lost production data). Then an excess cannot
 * be told from a gap: the receipt is verified for the bytes that *were* issued (never more),
 * marked `issuance: "unknown"`, and does not count against the relay's standing.
 */
export function checkReceipt(
  bytesReported: number,
  bytesIssued: number | null,
  tolerance: number,
  issuanceComplete = true,
): ReceiptCheck {
  const reported = Math.max(0, bytesReported);
  const issued = Math.max(0, bytesIssued ?? 0);
  if (reported === 0)
    return { status: "verified", bytesVerified: 0, overReportRatio: issued > 0 ? -1 : 0, issuance: "complete" };
  const ratio = issued > 0 ? reported / issued - 1 : Number.POSITIVE_INFINITY;
  if (ratio <= tolerance + RATIO_EPSILON)
    return {
      status: "verified",
      bytesVerified: Math.min(reported, issued),
      overReportRatio: ratio,
      issuance: "complete",
    };
  if (!issuanceComplete)
    return {
      status: "verified",
      bytesVerified: Math.min(reported, issued),
      overReportRatio: null,
      issuance: "unknown",
    };
  if (issued === 0) return { status: "rejected", bytesVerified: 0, overReportRatio: null, reason: "no_issuance" };
  return { status: "rejected", bytesVerified: 0, overReportRatio: ratio, reason: "over_report" };
}

export interface ReceiptHistoryEntry {
  periodStart?: Date;
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
 * checked periods, or in any single period by more than 3 × the tolerance. A rejected
 * receipt reporting bytes against no issuance counts as an unbounded over-report; a
 * verified receipt with unknown issuance (null ratio) counts as clean.
 *
 * `since` (a reinstatement) starts a fresh record: only periods that started at or after
 * it count, so a reinstated relay is not suspended again for what it was suspended for.
 */
export function relayStanding(
  history: readonly ReceiptHistoryEntry[],
  tolerance: number,
  since: Date | null = null,
): RelayStanding {
  const relevant = since ? history.filter((h) => (h.periodStart ?? h.periodEnd).getTime() >= since.getTime()) : history;
  const recent = [...relevant].sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime()).slice(0, STANDING_WINDOW);
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
