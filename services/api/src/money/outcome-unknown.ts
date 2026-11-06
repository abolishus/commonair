// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Money movements whose Stripe outcome is unknown (follow-ups, unit money; ADR 0007 decision 3 and
 * Amendment 1). "Outcome unknown" is not a column: it is derived from the refund request markers
 * (`stripe-refunds.ts`), `payout_transfers.failure_code = outcome_unknown` (M1-connect) and the
 * worker's `patronage.payout_outcome_unknown` marker (M1-coop-money).
 *
 * - `money.treasurer.outcomeUnknown`: how many of each, and their sum per currency.
 * - `money.treasurer.refundRequests.recheck`: ask Stripe again (`listRefunds` of the PaymentIntent)
 *   about one unknown refund request, with the reconciler's matching rules (`decideRecheck`, kept
 *   in step with the worker's `decideReconcile`). A definite "not refunded" (failed, canceled, or
 *   none of its amount) releases the request with a `payment.refund_request_failed` marker in the
 *   treasurer's name; a refund Stripe has is posted by its `charge.refunded` webhook, never here.
 *   Refused in the first 15 minutes after the outcome became unknown, like `resolve`: Stripe may not
 *   list a refund it is still creating, and a false "none" would let a second refund through.
 * - `money.treasurer.settleTransfer`: a creator payout transfer left `outcome_unknown` is settled
 *   from what Stripe's dashboard shows. `sent` takes the `tr_` id and records the transfer created
 *   (the payout is paid, `payoutSent`); `not_sent` fails it and cancels the payout back to the
 *   payable, as a definite refusal would. A transfer that turns up at Stripe later is recorded as
 *   orphaned by the webhook, never paid twice. The adapter cannot look a transfer up by its id yet
 *   (a contract request on `@commonair/payments`), so this records the treasurer's finding. Nobody
 *   settles their own payout. Audited (`payout_transfer.settle`), ids only.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RefundRequestView } from "@commonair/contracts/dto";
import { type Executor, schema } from "@commonair/db";
import {
  PAYOUT_TRANSFER_CODES,
  PayoutStateError,
  recordPayoutTransferCreated,
  recordPayoutTransferFailed,
} from "@commonair/ledger";
import { type ListedRefund, type PaymentAdapter, createAdapter } from "@commonair/payments";
import { STRIPE_TRANSFER_REFERENCE } from "../coop/patronage-payouts.ts";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { apiError, badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { requestMarker, viewsFor } from "./refund-requests.ts";
import {
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUEST_FAILED,
  REFUND_RESOLVE_GRACE_MS,
  type RefundMarker,
  type RefundPosting,
  paymentRefundStates,
  refundHistory,
} from "./stripe-refunds.ts";
import { transferRow, transferView } from "./transfers.ts";

const { auditLog, payments, payoutTransfers, patronagePayouts } = schema;

const ACTOR = "admin" as const;
/** `payout_transfers.failure_code` of a transfer a treasurer settled as never sent. */
export const SETTLED_UNSENT = "settled_unsent";
export const TRANSFER_SETTLED = "payout_transfer.settle";
/** The worker's marker (`services/worker/src/coop/patronage-payout.ts`). */
const PATRONAGE_OUTCOME_UNKNOWN = "patronage.payout_outcome_unknown";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

// ── The adapter (injectable: stripe-mock lists one fixture for every PaymentIntent) ─────────────

const adapters = new WeakMap<Deps, Pick<PaymentAdapter, "provider" | "listRefunds">>();

export function outcomeAdapter(deps: Deps): Pick<PaymentAdapter, "provider" | "listRefunds"> {
  return adapters.get(deps) ?? createAdapter(deps.env);
}

export function setOutcomeAdapter(deps: Deps, adapter: Pick<PaymentAdapter, "provider" | "listRefunds"> | null): void {
  if (adapter) adapters.set(deps, adapter);
  else adapters.delete(deps);
}

// ── Pure rules (unit-tested) ────────────────────────────────────────────────────────────────

export interface ListedProviderRefund {
  id: string;
  amountCents: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  metadata: Record<string, string>;
}

/** A provider listing as the rules read it (an unknown status counts as still pending). */
export function normalizeListed(r: ListedRefund): ListedProviderRefund {
  const s = r.status;
  return {
    id: r.id,
    amountCents: r.amount,
    currency: r.currency.toLowerCase(),
    status: s === "succeeded" || s === "failed" || s === "canceled" ? s : "pending",
    metadata: r.metadata,
  };
}

export type RecheckDecision = "refunded" | "pending" | "failed" | "none" | "ambiguous";

const KEY_FIELDS = ["refund_key", "idempotency_key"] as const;
const keyOf = (r: ListedProviderRefund): string | null => {
  for (const k of KEY_FIELDS) if (r.metadata[k]) return r.metadata[k] ?? null;
  return null;
};

/**
 * What Stripe's refunds say about one unknown request (pure): the refund carrying its key, else an
 * unkeyed one of the same amount nobody claimed (posted, or named by a marker), live ones first;
 * refunds of other amounts only are `ambiguous`; nothing at all is `none`. The worker's
 * `decideReconcile` applies the same rules.
 */
export function decideRecheck(
  request: { amountCents: number; currency: string; idempotencyKey: string | null },
  refunds: readonly ListedProviderRefund[],
  claimed: ReadonlySet<string>,
): { decision: RecheckDecision; refundRef: string | null } {
  const open = refunds.filter((r) => !claimed.has(r.id));
  const byStatus = (r: ListedProviderRefund): RecheckDecision =>
    r.status === "succeeded" ? "refunded" : r.status === "pending" ? "pending" : "failed";
  if (request.idempotencyKey !== null) {
    const keyed = open.find((r) => keyOf(r) === request.idempotencyKey);
    if (keyed) return { decision: byStatus(keyed), refundRef: keyed.id };
  }
  const unkeyed = open.filter((r) => keyOf(r) === null);
  const same = unkeyed.filter((r) => r.amountCents === request.amountCents && r.currency === request.currency);
  const best = same.find((r) => r.status === "succeeded") ?? same.find((r) => r.status === "pending") ?? same[0];
  if (best) return { decision: byStatus(best), refundRef: best.id };
  if (unkeyed.length > 0) return { decision: "ambiguous", refundRef: null };
  return { decision: "none", refundRef: null };
}

/** Refund ids already accounted for: posted, or named by a marker. */
export function claimedRefunds(markers: readonly RefundMarker[], postings: readonly RefundPosting[]): Set<string> {
  const out = new Set<string>();
  for (const p of postings) if (p.providerRef) out.add(p.providerRef);
  for (const m of markers) {
    const ref = str(m.details.refundRef);
    if (ref) out.add(ref);
  }
  return out;
}

/** Sum rows into `{count, amounts}`, one amount per currency in code order (pure). */
export function totalOf(rows: readonly { cents: number; currency: string }[]): {
  count: number;
  amounts: { cents: number; currency: string }[];
} {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0) + r.cents);
  return {
    count: rows.length,
    amounts: [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, cents]) => ({ cents, currency })),
  };
}

// ── The summary ─────────────────────────────────────────────────────────────────────────────

export async function outcomeUnknownSummary(db: Executor, now: Date) {
  // Refund requests: every payment with an unknown marker, then the request rules decide which
  // are still unknown (a webhook, the reconciler or a treasurer may have settled them since).
  const flagged = await db
    .selectDistinct({ paymentId: auditLog.subjectId })
    .from(auditLog)
    .where(and(eq(auditLog.action, REFUND_OUTCOME_UNKNOWN), eq(auditLog.subjectType, "payment")));
  const ids = flagged.map((f) => f.paymentId).filter((id) => UUID.test(id));
  const refundRows: { cents: number; currency: string }[] = [];
  if (ids.length > 0) {
    const ps = await db
      .select({ id: payments.id, currency: payments.currency })
      .from(payments)
      .where(inArray(payments.id, ids));
    for (const p of ps)
      for (const s of await paymentRefundStates(db, p.id, now))
        if (s.state === "unknown") refundRows.push({ cents: s.amountCents ?? 0, currency: p.currency });
  }
  const transfers = await db
    .select({ cents: payoutTransfers.amountCents, currency: payoutTransfers.currency })
    .from(payoutTransfers)
    .where(
      and(eq(payoutTransfers.status, "pending"), eq(payoutTransfers.failureCode, PAYOUT_TRANSFER_CODES.outcomeUnknown)),
    );
  const patronage = await db
    .select({ cents: patronagePayouts.amountCents, currency: patronagePayouts.currency })
    .from(patronagePayouts)
    .where(
      and(
        eq(patronagePayouts.status, "pending"),
        eq(patronagePayouts.provider, "stripe"),
        sql`exists (select 1 from audit_log m where m.subject_type = 'patronage_payout'
          and m.subject_id = ${patronagePayouts.id}::text and m.action = ${PATRONAGE_OUTCOME_UNKNOWN})`,
      ),
    );
  return { refunds: totalOf(refundRows), transfers: totalOf(transfers), patronagePayouts: totalOf(patronage) };
}

// ── Re-check a refund request ───────────────────────────────────────────────────────────────

export async function recheckRefundRequest(
  deps: Deps,
  input: { requestId: string; actorId: string },
): Promise<{ result: RecheckDecision | "unavailable"; request: RefundRequestView }> {
  const marker = await requestMarker(deps.db, input.requestId);
  if (!marker || !UUID.test(marker.subjectId)) throw notFound("Refund request not found");
  const now = deps.now();
  const [p] = await deps.db.select().from(payments).where(eq(payments.id, marker.subjectId));
  if (!p) throw notFound("Refund request not found");
  const s = (await paymentRefundStates(deps.db, p.id, now)).find((x) => x.requestId === input.requestId);
  if (!s || s.state !== "unknown") throw conflict("Only a refund request whose outcome is unknown is checked again");
  const since = (s.unknownAt ?? s.requestedAt).getTime();
  if (now.getTime() - since < REFUND_RESOLVE_GRACE_MS)
    throw precondition(
      "refund_reconciling",
      "The payment provider is still being asked about this refund; try again in a few minutes",
    );
  const view = async () => {
    const v = (await viewsFor(deps.db, [marker], deps.now())).get(marker.id);
    if (!v) throw notFound("Refund request not found");
    return v;
  };
  const adapter = outcomeAdapter(deps);
  const list = adapter.listRefunds?.bind(adapter);
  if (!list || adapter.provider !== p.provider || !p.providerRef)
    return { result: "unavailable", request: await view() };
  let refunds: ListedProviderRefund[];
  try {
    refunds = (await list(p.providerRef)).map(normalizeListed);
  } catch (err) {
    deps.logger.warn("refund recheck: the provider did not answer", {
      paymentId: p.id,
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
    return { result: "unavailable", request: await view() };
  }
  const h = await refundHistory(deps.db, p.id);
  const { decision, refundRef } = decideRecheck(
    { amountCents: s.amountCents ?? 0, currency: p.currency, idempotencyKey: s.idempotencyKey },
    refunds,
    claimedRefunds(h.markers, h.postings),
  );
  if (decision === "failed" || decision === "none") {
    await deps.db.transaction(async (tx) => {
      // The payment's row lock orders this against the webhook, the reconciler and resolve.
      const [locked] = await tx.select().from(payments).where(eq(payments.id, p.id)).for("update");
      if (!locked) return;
      const still = (await paymentRefundStates(tx, p.id, now)).find((x) => x.requestId === input.requestId);
      if (!still || still.state !== "unknown") return;
      await audit(tx, {
        actorType: ACTOR,
        actorId: input.actorId,
        action: REFUND_REQUEST_FAILED,
        subjectType: "payment",
        subjectId: p.id,
        channelId: p.channelId,
        details: {
          requestId: input.requestId,
          reason: decision === "none" ? "rechecked_none" : "rechecked_failed",
          ...(refundRef ? { refundRef } : {}),
        },
      });
    });
  } else if (decision === "refunded") {
    // Never posted from here: the ledger follows the provider's charge.refunded only.
    deps.logger.warn("refund recheck: refunded at the provider but not posted; is its webhook lost?", {
      paymentId: p.id,
      requestId: input.requestId,
    });
  }
  return { result: decision, request: await view() };
}

// ── Settle a payout transfer ────────────────────────────────────────────────────────────────

export async function settlePayoutTransfer(
  deps: Deps,
  input: {
    transferId: string;
    outcome: "sent" | "not_sent";
    reference?: string | undefined;
    note: string;
    actorId: string;
  },
) {
  const row = await transferRow(deps.db, input.transferId);
  if (!row) throw notFound("Transfer not found");
  if (row.u.id === input.actorId)
    throw apiError("FORBIDDEN", "Another treasurer or an admin settles your own payout", { reason: "second_approver" });
  if (row.t.status !== "pending") throw conflict(`This transfer is ${row.t.status}, not pending`);
  if (row.t.failureCode !== PAYOUT_TRANSFER_CODES.outcomeUnknown)
    throw conflict("Only a transfer whose outcome at Stripe is unknown is settled by hand");
  const reference = input.reference?.trim() ?? "";
  if (input.outcome === "sent" && !STRIPE_TRANSFER_REFERENCE.test(reference))
    throw badRequest("A transfer Stripe sent is recorded with its transfer id (tr_…)");
  const now = deps.now();
  try {
    await deps.db.transaction(async (tx) => {
      if (input.outcome === "sent") {
        const r = await recordPayoutTransferCreated(tx, { transferId: row.t.id, providerRef: reference, at: now });
        if (!r.created) throw conflict("This transfer was settled meanwhile");
      } else {
        const r = await recordPayoutTransferFailed(tx, { transferId: row.t.id, failureCode: SETTLED_UNSENT, at: now });
        if (!r.failed) throw conflict("This transfer was settled meanwhile");
      }
      await audit(tx, {
        actorType: ACTOR,
        actorId: input.actorId,
        action: TRANSFER_SETTLED,
        subjectType: "payout_transfer",
        subjectId: row.t.id,
        reason: input.note.trim(),
        details: { transferId: row.t.id, payoutId: row.t.payoutId, outcome: input.outcome },
      });
    });
  } catch (err) {
    // The webhook or the worker settled it first (another id, or created meanwhile).
    if (err instanceof PayoutStateError) throw conflict("This transfer changed; reload and try again");
    throw err;
  }
  const fresh = await transferRow(deps.db, row.t.id);
  if (!fresh) throw notFound("Transfer not found");
  return transferView(fresh);
}

// ── Handlers ────────────────────────────────────────────────────────────────────────────────

export const treasurerOutcomeHandlers = {
  outcomeUnknown: os.money.treasurer.outcomeUnknown.handler(async ({ context }) => {
    requireCaller(context);
    return outcomeUnknownSummary(context.deps.db, context.deps.now());
  }),
  settleTransfer: os.money.treasurer.settleTransfer.handler(async ({ context, input }) =>
    settlePayoutTransfer(context.deps, { ...input, actorId: requireCaller(context).user.id }),
  ),
};

export const refundRecheckHandler = os.money.treasurer.refundRequests.recheck.handler(async ({ context, input }) =>
  recheckRefundRequest(context.deps, { requestId: input.requestId, actorId: requireCaller(context).user.id }),
);
