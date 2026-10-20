// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Treasurer refunds of provider (Stripe) payments. The refund is asked of the provider and posted
 * only when its `charge.refunded` event arrives, so the ledger follows what the provider did.
 *
 * One outstanding request per payment: until the last one is posted, `refunded_cents` (and with it
 * what is left and the idempotency key) is stale. The request's lifecycle is recorded as
 * append-only audit markers, never holding a lock across the network:
 *
 * 1. a short transaction locks the payment, runs the guard and writes `payment.refund_requested`;
 * 2. after commit the provider is called (idempotency key from the payment's state, so retrying
 *    after a timeout returns the same refund instead of a second one);
 * 3. success writes `payment.refund_submitted` (with the refund id); failure writes
 *    `payment.refund_request_failed`, so a failed call never locks the payment out.
 *
 * A request stops blocking once it failed (our call, or Stripe's `refund.failed`), once its refund
 * id was posted, once a refund posting of the same amount without a known refund id followed it
 * (the cumulative `charge.refunded` path), or after `REFUND_REQUEST_TTL_MS`.
 */
import { and, eq, gt, inArray } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import type { PaymentAdapter } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { disputeOutcome } from "./checkout-rules.ts";

const { payments, disputes, auditLog } = schema;

export const REFUND_REQUESTED = "payment.refund_requested";
export const REFUND_SUBMITTED = "payment.refund_submitted";
export const REFUND_REQUEST_FAILED = "payment.refund_request_failed";
/** A request nobody resolved stops blocking after this (Stripe's own idempotency window). */
export const REFUND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export interface RefundMarker {
  action: string;
  createdAt: Date;
  details: Record<string, unknown>;
}
export interface RefundPosting {
  providerRef: string | null;
  amountCents: number;
  createdAt: Date;
}

const detail = (m: RefundMarker, key: string): string | null => {
  const v = m.details[key];
  return typeof v === "string" ? v : null;
};

/** Request ids still waiting for the provider (pure; see the module comment for the rules). */
export function outstandingRefundRequests(
  markers: readonly RefundMarker[],
  postings: readonly RefundPosting[],
  now: Date,
): string[] {
  const submittedRef = new Map<string, string>();
  const failedRequests = new Set<string>();
  const failedRefs = new Set<string>();
  for (const m of markers) {
    const id = detail(m, "requestId");
    const ref = detail(m, "refundRef");
    if (m.action === REFUND_SUBMITTED && id && ref) submittedRef.set(id, ref);
    if (m.action === REFUND_REQUEST_FAILED) {
      if (id) failedRequests.add(id);
      if (ref) failedRefs.add(ref);
    }
  }
  const knownRefs = new Set(submittedRef.values());
  const postedRefs = new Set(postings.flatMap((p) => (p.providerRef ? [p.providerRef] : [])));
  // Postings that name no refund we asked for: the cumulative path, or a dashboard refund.
  const anonymous = postings
    .filter((p) => !p.providerRef || !knownRefs.has(p.providerRef))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const used = new Set<RefundPosting>();
  const requests = markers
    .filter((m) => m.action === REFUND_REQUESTED)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out: string[] = [];
  for (const r of requests) {
    const id = detail(r, "requestId");
    if (!id) continue;
    if (now.getTime() - r.createdAt.getTime() > REFUND_REQUEST_TTL_MS) continue;
    if (failedRequests.has(id)) continue;
    const ref = submittedRef.get(id);
    if (ref && (failedRefs.has(ref) || postedRefs.has(ref))) continue;
    // Only a posting of exactly this amount, after the request, settles it without a refund id;
    // any other dashboard refund leaves it outstanding.
    const amount = r.details.amountCents;
    const match = anonymous.find(
      (p) => !used.has(p) && p.amountCents === amount && p.createdAt.getTime() >= r.createdAt.getTime(),
    );
    if (match) {
      used.add(match);
      continue;
    }
    out.push(id);
  }
  return out;
}

async function outstanding(tx: Executor, paymentId: string, now: Date): Promise<string[]> {
  const since = new Date(now.getTime() - REFUND_REQUEST_TTL_MS);
  const markers = await tx
    .select({ action: auditLog.action, createdAt: auditLog.createdAt, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectType, "payment"),
        eq(auditLog.subjectId, paymentId),
        inArray(auditLog.action, [REFUND_REQUESTED, REFUND_SUBMITTED, REFUND_REQUEST_FAILED]),
        gt(auditLog.createdAt, since),
      ),
    );
  const postings = await tx
    .select({ providerRef: disputes.providerRef, amountCents: disputes.amountCents, createdAt: disputes.createdAt })
    .from(disputes)
    .where(and(eq(disputes.paymentId, paymentId), eq(disputes.kind, "refund")));
  return outstandingRefundRequests(markers, postings, now);
}

/** Ask the provider to refund a provider payment (the treasurer's `refund` for non-manual payments). */
export async function requestProviderRefund(
  deps: Deps,
  adapter: PaymentAdapter,
  o: { paymentId: string; amountCents: number; reason: string; actorId: string },
): Promise<void> {
  const refund = adapter.refund?.bind(adapter);
  if (!refund) throw precondition("payment_provider", "This instance cannot refund through that payment provider");
  const now = deps.now();
  const requestId = uuidv7();
  // (1) Short transaction: guard and marker. The payment lock serializes treasurers only here.
  const p = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(payments).where(eq(payments.id, o.paymentId)).for("update");
    if (!row) throw notFound("Payment not found");
    const outcome = disputeOutcome("refund", row, o.amountCents);
    if (!outcome.ok) throw outcome.code === "CONFLICT" ? conflict(outcome.reason) : badRequest(outcome.reason);
    if ((await outstanding(tx, row.id, now)).length > 0)
      throw conflict("An earlier refund of this payment is still waiting for the payment provider");
    await audit(tx, {
      actorType: "admin",
      actorId: o.actorId,
      action: REFUND_REQUESTED,
      subjectType: "payment",
      subjectId: row.id,
      channelId: row.channelId,
      reason: o.reason,
      details: { requestId, amountCents: o.amountCents, provider: row.provider },
    });
    return row;
  });

  // (2) After commit: the provider call. The key follows the payment's state, so a retry after a
  // timeout (same amount, nothing posted since) gets the original refund back, never a second one.
  try {
    const requested = await refund({
      paymentId: p.id,
      providerRef: p.providerRef,
      amountCents: o.amountCents,
      idempotencyKey: `refund-${p.id}-${p.refundedCents}-${o.amountCents}`,
    });
    await audit(deps.db, {
      actorType: "admin",
      actorId: o.actorId,
      action: REFUND_SUBMITTED,
      subjectType: "payment",
      subjectId: p.id,
      channelId: p.channelId,
      details: { requestId, refundRef: requested.providerRef },
    });
  } catch (err) {
    // (3) Compensation: the request no longer blocks; the treasurer can try again.
    await audit(deps.db, {
      actorType: "system",
      actorId: null,
      action: REFUND_REQUEST_FAILED,
      subjectType: "payment",
      subjectId: p.id,
      channelId: p.channelId,
      details: { requestId },
    });
    deps.logger.warn("provider refund request failed", { paymentId: p.id, err });
    throw precondition("payment_provider", "The payment provider did not take the refund; try again");
  }
}

/** Stripe reported a refund failed: the request behind it stops blocking (webhook transaction). */
export async function recordProviderRefundFailed(
  tx: Executor,
  p: { id: string; channelId: string | null },
  refundRef: string,
): Promise<void> {
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: REFUND_REQUEST_FAILED,
    subjectType: "payment",
    subjectId: p.id,
    channelId: p.channelId,
    details: { refundRef },
  });
}
