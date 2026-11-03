// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Refund webhooks and the automatic refund after an end (ADR 0007 decisions 2 and 3):
 *
 * - `refundUpdated` runs in the webhook's transaction for Stripe's `refund.updated` and
 *   `charge.refund.updated` (a failure is still `refund.failed`, handled in `stripe-events.ts`).
 *   Nothing is posted here: success is posted from `charge.refunded`. A canceled refund releases
 *   its request like a failed one. A pending or succeeded refund that no request knows is the
 *   refund behind a request whose outcome is unknown, and its id is recorded on that request.
 *   Stripe sends one refund under both event types, so each refund id is recorded once.
 * - `runRefundFollowUp` runs after commit for the `auto_refund` follow-up that `invoice.paid`
 *   returns when it books money for an ended subscription (`paid_after_end`).
 */
import { and, eq } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import type { StripeAction } from "@commonair/payments";
import type { Deps } from "../../deps.ts";
import { autoRefundAfterEnd } from "../auto-refund.ts";
import type { AppliedAction, FollowUp } from "../stripe-events.ts";
import { attachRefundToUnknownRequest, recordProviderRefundFailed } from "../stripe-refunds.ts";

const { payments } = schema;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const outcome = (o: string): AppliedAction => ({ outcome: o, invalidate: [], cancelProviderSubscriptions: [] });

async function lockRefundPayment(tx: Executor, a: { paymentIntent: string | null; paymentId: string | null }) {
  if (a.paymentIntent) {
    const [p] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.provider, "stripe"), eq(payments.providerRef, a.paymentIntent)))
      .for("update");
    if (p) return p;
  }
  if (a.paymentId && UUID.test(a.paymentId)) {
    const [p] = await tx.select().from(payments).where(eq(payments.id, a.paymentId)).for("update");
    if (p?.provider === "stripe") return p;
  }
  return null;
}

export async function refundUpdated(
  tx: Executor,
  a: Extract<StripeAction, { type: "refund.updated" }>,
  now: Date,
): Promise<AppliedAction> {
  const p = await lockRefundPayment(tx, a);
  // Not a refund of ours (or of a payment this instance never saw).
  if (!p) return outcome("ignored");
  if (a.currency !== p.currency) return outcome("refund_currency_mismatch");
  if (a.status === "canceled") {
    await recordProviderRefundFailed(tx, p, a.refundId, now, a.amountCents);
    return outcome("refund_canceled");
  }
  const attached = await attachRefundToUnknownRequest(
    tx,
    p,
    { refundRef: a.refundId, amountCents: a.amountCents },
    now,
  );
  return outcome(attached ? "refund_attached" : "refund_updated");
}

/** After commit, outside the payment's row lock. */
export async function runRefundFollowUp(deps: Deps, followUp: FollowUp): Promise<void> {
  if (followUp.kind === "auto_refund") await autoRefundAfterEnd(deps, followUp.paymentId);
}
