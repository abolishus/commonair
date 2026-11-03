// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `checkout.completed` for a co-op share (batch 8, M1-coop-money; ADR 0020). A stub until that
 * unit fills it: it keeps today's behaviour, the generic checkout path (`generic`), which
 * `stripe-events.ts` passes in. M1-coop-money replaces it with the share confirmation, the
 * `share_purchase` posting and the membership activation, in this transaction with its event.
 */
import type { Executor, schema } from "@commonair/db";
import type { StripeAction } from "@commonair/payments";
import type { AppliedAction, PreparedAction } from "../stripe-events.ts";

export function shareCheckoutCompleted(
  _tx: Executor,
  _payment: typeof schema.payments.$inferSelect,
  _a: Extract<StripeAction, { type: "checkout.completed" }>,
  _prepared: PreparedAction,
  _now: Date,
  generic: () => Promise<AppliedAction>,
): Promise<AppliedAction> {
  return generic();
}
