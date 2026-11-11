// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The delete dialog's impact list (D7.4), pure for unit tests: which lines `me.deletion.preview`
 * calls for, in the order the dialog shows them. The general lines (what is removed, what is kept
 * without a name or email, ADR 0004) always show, also when the preview did not load.
 */
import type { DeletionPreview } from "@commonair/contracts/dto";

export type ImpactLine =
  | { kind: "removed" }
  | { kind: "kept" }
  | { kind: "subscriptions"; count: number }
  | { kind: "channelSubscriptions"; count: number }
  | { kind: "endingEarly"; count: number }
  | { kind: "payout"; amount: { cents: number; currency: string } }
  | { kind: "membership"; share: { cents: number; currency: string } | null }
  | { kind: "legalHold" };

export function impactLines(preview: DeletionPreview | null): ImpactLine[] {
  const lines: ImpactLine[] = [{ kind: "removed" }, { kind: "kept" }];
  if (!preview) return lines;
  if (preview.activeSubscriptions > 0) lines.push({ kind: "subscriptions", count: preview.activeSubscriptions });
  if (preview.channelSubscriptions > 0)
    lines.push({ kind: "channelSubscriptions", count: preview.channelSubscriptions });
  // ADR 0042: renewal stops at the request; only time paid past the date ends early, unrefunded.
  if (preview.endingBeforePaidThrough > 0) lines.push({ kind: "endingEarly", count: preview.endingBeforePaidThrough });
  if (preview.pendingPayout && preview.pendingPayout.cents > 0)
    lines.push({ kind: "payout", amount: preview.pendingPayout });
  if (preview.memberships.length > 0) {
    // One line: every membership ends together; the share (viewer class only) says how it comes back.
    const share = preview.memberships.find((m) => m.shareRefund !== null)?.shareRefund ?? null;
    lines.push({ kind: "membership", share });
  }
  if (preview.legalHold) lines.push({ kind: "legalHold" });
  return lines;
}

/** Confirm is allowed once the download step is ticked and the typed username matches (any case). */
export function canConfirm(input: { downloaded: boolean; typed: string; username: string }): boolean {
  const typed = input.typed.trim();
  return input.downloaded && typed !== "" && typed.toLowerCase() === input.username.trim().toLowerCase();
}
