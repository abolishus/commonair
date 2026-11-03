// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Automatic refund of money collected for an ended subscription (ADR 0007 decision 2). The
 * `invoice.paid` handler books the money (`paid_after_end`) and returns an `auto_refund` follow-up;
 * the webhook runs this after its transaction commits, outside the row lock.
 *
 * - It asks the provider for the full unrefunded amount through `requestProviderRefund`, with the
 *   system as actor and `details.reason = paid_after_end`, under the one-outstanding guard. The
 *   posting still follows Stripe's `charge.refunded`, as for any refund.
 * - It never touches the subscription: it stays ended.
 * - It is idempotent: a payment that already has an automatic request (whatever became of it), an
 *   outstanding request, or nothing left to refund is left alone.
 * - A payment whose provider this instance cannot refund through (a manual payment) gets a request
 *   marker only, so the treasurer sees it in the refund list with reason `paid_after_end` and
 *   refunds it by hand.
 *
 * The hook is best effort: a crash after the commit loses it. The worker's `refund-reconcile`
 * sweep is the durable trigger (`services/worker/src/money/refund-reconcile.ts`).
 */
import { eq } from "drizzle-orm";
import { schema, uuidv7 } from "@commonair/db";
import { createAdapter } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import {
  PAID_AFTER_END,
  REFUND_REQUESTED,
  errorName,
  paymentRefundStates,
  refundHistory,
  requestProviderRefund,
} from "./stripe-refunds.ts";

const { payments } = schema;

export type AutoRefundOutcome =
  | "requested"
  | "unknown"
  | "already_requested"
  | "outstanding"
  | "nothing_left"
  | "not_refundable"
  | "listed_for_treasurer"
  | "failed";

const REFUNDABLE = new Set(["succeeded", "partially_refunded"]);

export async function autoRefundAfterEnd(deps: Deps, paymentId: string): Promise<AutoRefundOutcome> {
  const now = deps.now();
  const [p] = await deps.db.select().from(payments).where(eq(payments.id, paymentId));
  if (!p || !REFUNDABLE.has(p.status)) return "not_refundable";
  const rest = p.amountCents - p.refundedCents;
  if (rest <= 0) return "nothing_left";
  const { markers } = await refundHistory(deps.db, p.id);
  if (markers.some((m) => m.action === REFUND_REQUESTED && m.details.reason === PAID_AFTER_END))
    return "already_requested";
  if ((await paymentRefundStates(deps.db, p.id, now)).some((s) => s.blocking)) return "outstanding";

  const adapter = createAdapter(deps.env);
  if (adapter.provider !== p.provider || !adapter.refund) {
    // Nothing to ask a provider: list it for the treasurer, who refunds it by hand (the manual
    // refund's posting, of this amount, settles the request).
    const listed = await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(payments).where(eq(payments.id, p.id)).for("update");
      if (!row) return false;
      const h = await refundHistory(tx, row.id);
      if (h.markers.some((m) => m.action === REFUND_REQUESTED && m.details.reason === PAID_AFTER_END)) return false;
      await audit(tx, {
        actorType: "system",
        actorId: null,
        action: REFUND_REQUESTED,
        subjectType: "payment",
        subjectId: row.id,
        channelId: row.channelId,
        details: {
          requestId: uuidv7(),
          amountCents: row.amountCents - row.refundedCents,
          provider: row.provider,
          reason: PAID_AFTER_END,
        },
      });
      return true;
    });
    return listed ? "listed_for_treasurer" : "already_requested";
  }

  try {
    const outcome = await requestProviderRefund(deps, adapter, {
      paymentId: p.id,
      amountCents: rest,
      reason: "",
      actorId: null,
      autoReason: PAID_AFTER_END,
    });
    deps.logger.info("automatic refund requested", { paymentId: p.id, outcome });
    return outcome === "submitted" ? "requested" : "unknown";
  } catch (err) {
    // CONFLICT (a request raced in), or the provider refused or did not answer: the markers say
    // which, and the reconciler's sweep or the treasurer takes it from there.
    deps.logger.warn("automatic refund not requested", { paymentId: p.id, error: errorName(err) });
    return "failed";
  }
}
