// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Refund webhooks and the automatic refund after an end (batch 8, M1-gifts-refunds; ADR 0007
 * decisions 2 and 3). Stubs until that unit fills them:
 *
 * - `refundUpdated` runs in the webhook's transaction for Stripe's `refund.updated` (a failure is
 *   still `refund.failed`, handled in `stripe-events.ts`). It answers `ignored`.
 * - `runRefundFollowUp` runs after commit for the `auto_refund` follow-up that `invoice.paid`
 *   returns when it books money for an ended subscription (`paid_after_end`).
 */
import type { Executor } from "@commonair/db";
import type { StripeAction } from "@commonair/payments";
import type { Deps } from "../../deps.ts";
import { autoRefundAfterEnd } from "../auto-refund.ts";
import type { AppliedAction, FollowUp } from "../stripe-events.ts";

export async function refundUpdated(
  _tx: Executor,
  _a: Extract<StripeAction, { type: "refund.updated" }>,
  _now: Date,
): Promise<AppliedAction> {
  return { outcome: "ignored", invalidate: [], cancelProviderSubscriptions: [] };
}

/** After commit, outside the payment's row lock. */
export async function runRefundFollowUp(deps: Deps, followUp: FollowUp): Promise<void> {
  if (followUp.kind === "auto_refund") await autoRefundAfterEnd(deps, followUp.paymentId);
}
