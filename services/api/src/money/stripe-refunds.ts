// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Provider (Stripe) refunds of provider payments: the treasurer's, and the automatic refund of
 * money booked for an ended subscription (`auto-refund.ts`). The refund is asked of the provider and
 * posted only when its `charge.refunded` event arrives, so the ledger follows what the provider did.
 *
 * One outstanding request per payment: until the last one is posted, `refunded_cents` (and with it
 * what is left and the idempotency key) is stale. The request's lifecycle is recorded as
 * append-only audit markers, never holding a lock across the network:
 *
 * 1. a short transaction locks the payment, runs the guard and writes `payment.refund_requested`;
 * 2. after commit the provider is called (idempotency key from the payment's state, so retrying
 *    after a timeout returns the same refund instead of a second one);
 * 3. success writes `payment.refund_submitted` (with the refund id). A definite refusal (a 4xx, or
 *    a local error before anything was sent) writes `payment.refund_request_failed`, so it never
 *    locks the payment out. An unknown outcome (timeout, network, 5xx after the client's retries;
 *    ADR 0007 decision 3) writes `payment.refund_outcome_unknown` with the key it used, and keeps
 *    blocking: Stripe may have refunded.
 *
 * A request stops blocking once it failed (our call, Stripe's `refund.failed`, or the reconciler
 * finding no refund), once a treasurer resolved it, once its refund id was posted, once a refund
 * posting of the same amount without a known refund id followed it (the cumulative
 * `charge.refunded` path), or after `REFUND_REQUEST_TTL_MS`. An unknown request past the TTL stops
 * blocking but stays listed as `unknown` until something settles it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  AdapterUnavailableError,
  type PaymentAdapter,
  StripeOutcomeUnknown,
  isDefiniteRefusal,
} from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { disputeOutcome } from "./checkout-rules.ts";

const { payments, disputes, auditLog } = schema;

export const REFUND_REQUESTED = "payment.refund_requested";
export const REFUND_SUBMITTED = "payment.refund_submitted";
export const REFUND_REQUEST_FAILED = "payment.refund_request_failed";
export const REFUND_OUTCOME_UNKNOWN = "payment.refund_outcome_unknown";
/**
 * A treasurer settled a request by hand (`refundRequests.resolve`). Audited, and read as a release
 * marker; it is not one of the contract's `REFUND_MARKER_ACTIONS`, so the view leaves it out of
 * `markers` and shows it as the `resolved` state.
 */
export const REFUND_REQUEST_RESOLVED = "payment.refund_resolved";
/** Every audit action the request rules read. */
export const REFUND_MARKER_ACTIONS_READ = [
  REFUND_REQUESTED,
  REFUND_SUBMITTED,
  REFUND_REQUEST_FAILED,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUEST_RESOLVED,
] as const;
/** A request nobody resolved stops blocking after this (Stripe's own idempotency window). */
export const REFUND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
/** `resolve` is refused this long after the request: the reconciler (every 15 min) asks Stripe first. */
export const REFUND_RESOLVE_GRACE_MS = 15 * 60 * 1000;
/** `details.reason` of an automatic refund of money booked for an ended subscription (ADR 0007 decision 2). */
export const PAID_AFTER_END = "paid_after_end";
/**
 * Harness fault hook (OPS_TEST_HOOKS only): while this Valkey key exists for a payment, its next
 * provider refund call is answered as a timeout (`StripeOutcomeUnknown`) without reaching Stripe.
 * stripe-mock never times out, so `e4b-money`'s `refund-unknown` step sets it (decision (b)).
 */
export const refundFaultKey = (paymentId: string) => `test:fault:refund-unknown:${paymentId}`;

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

export type RefundRequestState = "outstanding" | "unknown" | "resolved";

/** One request as the markers and postings say it stands (pure; `refundRequestStates`). */
export interface RefundRequestStatus {
  requestId: string;
  requestedAt: Date;
  amountCents: number | null;
  state: RefundRequestState;
  /** Whether it still keeps a new request out (within the TTL and not settled). */
  blocking: boolean;
  /** When the outcome became unknown, or null. */
  unknownAt: Date | null;
  /** The idempotency key of the call whose outcome is unknown, or null. */
  idempotencyKey: string | null;
  /** The provider's refund id once known. */
  refundRef: string | null;
  /** `paid_after_end` for an automatic refund. */
  reason: typeof PAID_AFTER_END | null;
}

const detail = (m: RefundMarker, key: string): string | null => {
  const v = m.details[key];
  return typeof v === "string" ? v : null;
};
const byTime = (a: { createdAt: Date }, b: { createdAt: Date }) => a.createdAt.getTime() - b.createdAt.getTime();

/** Every request in `markers` with its state (pure; see the module comment for the rules). */
export function refundRequestStates(
  markers: readonly RefundMarker[],
  postings: readonly RefundPosting[],
  now: Date,
): RefundRequestStatus[] {
  const submittedRef = new Map<string, string>();
  const released = new Set<string>();
  const failedRefs = new Set<string>();
  const unknown = new Map<string, { at: Date; key: string | null }>();
  for (const m of [...markers].sort(byTime)) {
    const id = detail(m, "requestId");
    const ref = detail(m, "refundRef");
    if (m.action === REFUND_SUBMITTED && id && ref) submittedRef.set(id, ref);
    if (m.action === REFUND_REQUEST_FAILED) {
      if (id) released.add(id);
      if (ref) failedRefs.add(ref);
    }
    if (m.action === REFUND_REQUEST_RESOLVED && id) released.add(id);
    if (m.action === REFUND_OUTCOME_UNKNOWN && id && !unknown.has(id))
      unknown.set(id, { at: m.createdAt, key: detail(m, "idempotencyKey") });
  }
  const knownRefs = new Set(submittedRef.values());
  const postedRefs = new Set(postings.flatMap((p) => (p.providerRef ? [p.providerRef] : [])));
  // Postings that name no refund we know of: the cumulative path, a dashboard refund, or the
  // refund behind a request whose outcome is unknown.
  const anonymous = postings.filter((p) => !p.providerRef || !knownRefs.has(p.providerRef)).sort(byTime);
  const used = new Set<RefundPosting>();
  const out: RefundRequestStatus[] = [];
  for (const r of markers.filter((m) => m.action === REFUND_REQUESTED).sort(byTime)) {
    const id = detail(r, "requestId");
    if (!id) continue;
    const amount = typeof r.details.amountCents === "number" ? r.details.amountCents : null;
    const ref = submittedRef.get(id) ?? null;
    let settled = released.has(id) || (ref !== null && (failedRefs.has(ref) || postedRefs.has(ref)));
    if (!settled) {
      // Only a posting of exactly this amount, after the request, settles it without a refund id;
      // any other dashboard refund leaves it open. Expired requests take theirs too, so a refund
      // posted while one blocked keeps it settled after the TTL.
      const match = anonymous.find(
        (p) => !used.has(p) && p.amountCents === amount && p.createdAt.getTime() >= r.createdAt.getTime(),
      );
      if (match) {
        used.add(match);
        settled = true;
      }
    }
    const live = now.getTime() - r.createdAt.getTime() <= REFUND_REQUEST_TTL_MS;
    const u = unknown.get(id) ?? null;
    const state: RefundRequestState = settled
      ? "resolved"
      : u !== null && ref === null
        ? "unknown"
        : live
          ? "outstanding"
          : "resolved";
    out.push({
      requestId: id,
      requestedAt: r.createdAt,
      amountCents: amount,
      state,
      blocking: !settled && live,
      unknownAt: u?.at ?? null,
      idempotencyKey: u?.key ?? null,
      refundRef: ref,
      reason: detail(r, "reason") === PAID_AFTER_END ? PAID_AFTER_END : null,
    });
  }
  return out;
}

/** Request ids still waiting for the provider (pure; see the module comment for the rules). */
export function outstandingRefundRequests(
  markers: readonly RefundMarker[],
  postings: readonly RefundPosting[],
  now: Date,
): string[] {
  return refundRequestStates(markers, postings, now)
    .filter((s) => s.blocking)
    .map((s) => s.requestId);
}

/** How a failed provider call ends a request: released (nothing happened) or kept (it may have). */
export function classifyRefundError(err: unknown): "failed" | "unknown" {
  // A definite 4xx, or a local refusal before anything was sent (no PaymentIntent, no adapter).
  if (isDefiniteRefusal(err) || err instanceof RangeError || err instanceof AdapterUnavailableError) return "failed";
  // Timeouts, network errors, 5xx/409/429 after retries, and anything unexpected: Stripe may have acted.
  return "unknown";
}

/** Every marker and refund posting of a payment (the caller holds its row lock when it matters). */
export async function refundHistory(
  tx: Executor,
  paymentId: string,
): Promise<{ markers: RefundMarker[]; postings: RefundPosting[] }> {
  const markers = await tx
    .select({ action: auditLog.action, createdAt: auditLog.createdAt, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectType, "payment"),
        eq(auditLog.subjectId, paymentId),
        inArray(auditLog.action, [...REFUND_MARKER_ACTIONS_READ]),
      ),
    );
  const postings = await tx
    .select({ providerRef: disputes.providerRef, amountCents: disputes.amountCents, createdAt: disputes.createdAt })
    .from(disputes)
    .where(and(eq(disputes.paymentId, paymentId), eq(disputes.kind, "refund")));
  return { markers, postings };
}

export async function paymentRefundStates(tx: Executor, paymentId: string, now: Date): Promise<RefundRequestStatus[]> {
  const h = await refundHistory(tx, paymentId);
  return refundRequestStates(h.markers, h.postings, now);
}

async function consumeFault(deps: Deps, paymentId: string): Promise<boolean> {
  if (!deps.env.OPS_TEST_HOOKS) return false;
  try {
    return (await deps.valkey.del(refundFaultKey(paymentId))) > 0;
  } catch {
    return false;
  }
}

export interface ProviderRefundRequest {
  paymentId: string;
  amountCents: number;
  /** The treasurer's own words (audited); empty for the system. */
  reason: string;
  /** The treasurer, or null for the system (an automatic refund). */
  actorId: string | null;
  /** `paid_after_end` for an automatic refund. */
  autoReason?: typeof PAID_AFTER_END;
}

export type ProviderRefundOutcome = "submitted" | "unknown";

/**
 * Ask the provider to refund a provider payment (the treasurer's `refund` for non-manual payments,
 * and `autoRefundAfterEnd`). Throws CONFLICT while an earlier request blocks, and
 * PRECONDITION_FAILED when the provider refused (released) or did not answer (kept, `unknown`).
 */
export async function requestProviderRefund(
  deps: Deps,
  adapter: PaymentAdapter,
  o: ProviderRefundRequest,
): Promise<ProviderRefundOutcome> {
  const refund = adapter.refund?.bind(adapter);
  if (!refund) throw precondition("payment_provider", "This instance cannot refund through that payment provider");
  const now = deps.now();
  const requestId = uuidv7();
  const actor =
    o.actorId === null
      ? ({ actorType: "system", actorId: null } as const)
      : { actorType: "admin" as const, actorId: o.actorId };
  // (1) Short transaction: guard and marker. The payment lock serializes requests only here.
  const p = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(payments).where(eq(payments.id, o.paymentId)).for("update");
    if (!row) throw notFound("Payment not found");
    const outcome = disputeOutcome("refund", row, o.amountCents);
    if (!outcome.ok) throw outcome.code === "CONFLICT" ? conflict(outcome.reason) : badRequest(outcome.reason);
    if ((await paymentRefundStates(tx, row.id, now)).some((s) => s.blocking))
      throw conflict("An earlier refund of this payment is still waiting for the payment provider");
    await audit(tx, {
      ...actor,
      action: REFUND_REQUESTED,
      subjectType: "payment",
      subjectId: row.id,
      channelId: row.channelId,
      reason: o.reason,
      details: {
        requestId,
        amountCents: o.amountCents,
        provider: row.provider,
        ...(o.autoReason ? { reason: o.autoReason } : {}),
      },
    });
    return row;
  });

  // (2) After commit: the provider call. The key follows the payment's state, so a retry after a
  // timeout (same amount, nothing posted since) gets the original refund back, never a second one.
  const idempotencyKey = `refund-${p.id}-${p.refundedCents}-${o.amountCents}`;
  try {
    if (await consumeFault(deps, p.id))
      throw new StripeOutcomeUnknown("injected timeout (OPS_TEST_HOOKS)", 504, null, null);
    const requested = await refund({
      paymentId: p.id,
      providerRef: p.providerRef,
      amountCents: o.amountCents,
      idempotencyKey,
    });
    await audit(deps.db, {
      ...actor,
      action: REFUND_SUBMITTED,
      subjectType: "payment",
      subjectId: p.id,
      channelId: p.channelId,
      details: { requestId, refundRef: requested.providerRef },
    });
    return "submitted";
  } catch (err) {
    if (classifyRefundError(err) === "unknown") {
      // (3b) Stripe may have refunded: keep blocking until the webhook, the reconciler or a treasurer settles it.
      await audit(deps.db, {
        actorType: "system",
        actorId: null,
        action: REFUND_OUTCOME_UNKNOWN,
        subjectType: "payment",
        subjectId: p.id,
        channelId: p.channelId,
        details: { requestId, idempotencyKey },
      });
      deps.logger.warn("provider refund outcome unknown", { paymentId: p.id, error: errorName(err) });
      throw precondition(
        "payment_provider",
        "The payment provider did not answer; the refund is being checked and must not be asked again yet",
      );
    }
    // (3a) Compensation: the request no longer blocks; the treasurer can try again.
    await audit(deps.db, {
      actorType: "system",
      actorId: null,
      action: REFUND_REQUEST_FAILED,
      subjectType: "payment",
      subjectId: p.id,
      channelId: p.channelId,
      details: { requestId },
    });
    deps.logger.warn("provider refund request failed", { paymentId: p.id, error: errorName(err) });
    throw precondition("payment_provider", "The payment provider did not take the refund; try again");
  }
}

/**
 * Stripe reported a refund failed (`refund.failed`, or `refund.updated` canceled): the request
 * behind it stops blocking. Runs in the webhook's transaction with the payment row locked. A refund
 * id no request submitted is the refund of the oldest request whose outcome is unknown. Stripe sends
 * the same failure under several event types, so a refund id already marked is not marked again.
 */
export async function recordProviderRefundFailed(
  tx: Executor,
  p: { id: string; channelId: string | null },
  refundRef: string,
  now: Date = new Date(),
): Promise<void> {
  const { markers, postings } = await refundHistory(tx, p.id);
  if (markers.some((m) => m.action === REFUND_REQUEST_FAILED && detail(m, "refundRef") === refundRef)) return;
  const states = refundRequestStates(markers, postings, now);
  const owner =
    states.find((s) => s.refundRef === refundRef) ??
    states.filter((s) => s.state === "unknown").sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())[0];
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: REFUND_REQUEST_FAILED,
    subjectType: "payment",
    subjectId: p.id,
    channelId: p.channelId,
    details: owner ? { refundRef, requestId: owner.requestId } : { refundRef },
  });
}

/**
 * A refund Stripe reports as pending or succeeded (`refund.updated`) for a payment with a request
 * whose outcome is unknown: the refund id is that request's (the oldest unknown one of the same
 * amount), so it settles when that id is posted or fails. Payment row locked by the caller.
 * Returns whether a marker was written.
 */
export async function attachRefundToUnknownRequest(
  tx: Executor,
  p: { id: string; channelId: string | null },
  refund: { refundRef: string; amountCents: number },
  now: Date,
): Promise<boolean> {
  const { markers, postings } = await refundHistory(tx, p.id);
  if (markers.some((m) => detail(m, "refundRef") === refund.refundRef)) return false;
  if (postings.some((d) => d.providerRef === refund.refundRef)) return false;
  const owner = refundRequestStates(markers, postings, now)
    .filter((s) => s.state === "unknown" && s.amountCents === refund.amountCents)
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())[0];
  if (!owner) return false;
  await audit(tx, {
    actorType: "system",
    actorId: null,
    action: REFUND_SUBMITTED,
    subjectType: "payment",
    subjectId: p.id,
    channelId: p.channelId,
    details: { requestId: owner.requestId, refundRef: refund.refundRef },
  });
  return true;
}

/** An error's class name only, never its message (a provider message may carry anything). */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
