// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `refund-reconcile` (every 15 minutes; ADR 0007 decisions 2 and 3). Two passes:
 *
 * 1. **Unknown outcomes.** For each provider refund request whose outcome became unknown at least
 *    `RECONCILE_MIN_AGE_MS` ago and that is younger than 7 days, ask the provider what became of it (`listRefunds` of the PaymentIntent;
 *    a refund carrying the request's idempotency key in its metadata is that request's, otherwise
 *    one of the same amount that no other request or posting claims):
 *    - it exists and succeeded: nothing to do, because the `charge.refunded` webhook posts it (the
 *      ledger follows the provider's events only, never this job); a warn log names the payment,
 *      since its webhook may have been lost;
 *    - it is still pending: leave it;
 *    - it failed or was canceled, or there is definitely none: `payment.refund_request_failed`
 *      with `details.reason` `reconciled_failed` / `reconciled_none`, which releases the request;
 *    - only refunds of other amounts (a treasurer refunded by hand at Stripe): no marker, a warn log;
 *    - the provider cannot be asked, or did not answer: leave it.
 *    The marker is written under the payment's row lock after the request's state is read again,
 *    so a webhook that settled it meanwhile is never followed by a second failure marker.
 * 2. **The durable trigger for automatic refunds.** The API asks for the refund of money booked for
 *    an ended subscription right after the webhook commits (`services/api/src/money/auto-refund.ts`),
 *    best effort. This pass finds such bookings (a Stripe subscription payment created after its
 *    subscription had ended, or a gift paid after its window and booked without starting any of
 *    its gift subscriptions) that are 15 minutes to 7 days old and have no automatic request, and
 *    makes it with the same markers and idempotency key.
 *
 * The request rules are the API's (`services/api/src/money/stripe-refunds.ts`
 * `refundRequestStates`), carried here as the API and media carry the media-state rules; the
 * shared fixtures in both test files keep them in step.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { loadEnv, paymentsEnv } from "@commonair/config";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { meter } from "@commonair/observability";
import {
  AdapterUnavailableError,
  type PaymentAdapter,
  type RefundRequest,
  createAdapter,
  isDefiniteRefusal,
} from "@commonair/payments";
import type { WorkerContext } from "../context.ts";

const { payments, disputes, auditLog } = schema;

export const REFUND_REQUESTED = "payment.refund_requested";
export const REFUND_SUBMITTED = "payment.refund_submitted";
export const REFUND_REQUEST_FAILED = "payment.refund_request_failed";
export const REFUND_OUTCOME_UNKNOWN = "payment.refund_outcome_unknown";
export const REFUND_REQUEST_RESOLVED = "payment.refund_resolved";
const MARKERS = [
  REFUND_REQUESTED,
  REFUND_SUBMITTED,
  REFUND_REQUEST_FAILED,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUEST_RESOLVED,
] as const;
export const REFUND_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const PAID_AFTER_END = "paid_after_end";
/**
 * An unknown outcome is first asked about this long after it became unknown: Stripe may still be
 * processing the call that timed out, and an empty listing seconds later is not yet "none".
 */
export const RECONCILE_MIN_AGE_MS = 5 * 60 * 1000;
/** Unknown requests older than this are the treasurer's (`refundRequests.resolve`). */
export const RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The API's after-commit hook gets this long before the sweep makes the automatic request. */
export const SWEEP_MIN_AGE_MS = 15 * 60 * 1000;
/** Bookings older than this are left to the treasurer. */
export const SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** `created_at` (Postgres' transaction start) and `updated_at` (the API's clock) may disagree a little. */
const BOOKED_AFTER_END_SKEW_MS = 10_000;
/** Requests and bookings looked at per run (the rest waits for the next tick). */
export const RECONCILE_BATCH = 200;

const m = meter("commonair.worker");
const reconcileMetrics = {
  outcomes: m.createCounter("worker.money.refund_reconcile", {
    description: "Refund requests with an unknown outcome, by what the reconciler found (ADR 0007 decision 3)",
  }),
  autoRefunds: m.createCounter("worker.money.auto_refunds", {
    description: "Automatic refunds of money booked for an ended subscription made by the sweep, by outcome",
  }),
};

// ------------------------------------------------------------ the request rules (pure)

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
export interface RequestState {
  requestId: string;
  requestedAt: Date;
  amountCents: number | null;
  state: "outstanding" | "unknown" | "resolved";
  blocking: boolean;
  /** When the outcome became unknown, or null. */
  unknownAt: Date | null;
  idempotencyKey: string | null;
  refundRef: string | null;
  reason: typeof PAID_AFTER_END | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const byTime = (a: { createdAt: Date }, b: { createdAt: Date }) => a.createdAt.getTime() - b.createdAt.getTime();

/** The API's `refundRequestStates` (`services/api/src/money/stripe-refunds.ts`), rule for rule. */
export function requestStates(
  markers: readonly RefundMarker[],
  postings: readonly RefundPosting[],
  now: Date,
): RequestState[] {
  const submittedRef = new Map<string, string>();
  const released = new Set<string>();
  const failedRefs = new Set<string>();
  const unknown = new Map<string, { at: Date; key: string | null }>();
  for (const mk of [...markers].sort(byTime)) {
    const id = str(mk.details.requestId);
    const ref = str(mk.details.refundRef);
    if (mk.action === REFUND_SUBMITTED && id && ref) submittedRef.set(id, ref);
    if (mk.action === REFUND_REQUEST_FAILED) {
      if (id) released.add(id);
      if (ref) failedRefs.add(ref);
    }
    if (mk.action === REFUND_REQUEST_RESOLVED && id) released.add(id);
    if (mk.action === REFUND_OUTCOME_UNKNOWN && id && !unknown.has(id))
      unknown.set(id, { at: mk.createdAt, key: str(mk.details.idempotencyKey) });
  }
  const knownRefs = new Set(submittedRef.values());
  const postedRefs = new Set(postings.flatMap((p) => (p.providerRef ? [p.providerRef] : [])));
  const anonymous = postings.filter((p) => !p.providerRef || !knownRefs.has(p.providerRef)).sort(byTime);
  const used = new Set<RefundPosting>();
  const out: RequestState[] = [];
  for (const r of markers.filter((mk) => mk.action === REFUND_REQUESTED).sort(byTime)) {
    const id = str(r.details.requestId);
    if (!id) continue;
    const amount = typeof r.details.amountCents === "number" ? r.details.amountCents : null;
    const ref = submittedRef.get(id) ?? null;
    let settled = released.has(id) || (ref !== null && (failedRefs.has(ref) || postedRefs.has(ref)));
    if (!settled) {
      const from = r.createdAt.getTime();
      const match = anonymous.find(
        (p) =>
          !used.has(p) &&
          p.amountCents === amount &&
          p.createdAt.getTime() >= from &&
          p.createdAt.getTime() <= from + REFUND_REQUEST_TTL_MS,
      );
      if (match) {
        used.add(match);
        settled = true;
      }
    }
    const live = now.getTime() - r.createdAt.getTime() <= REFUND_REQUEST_TTL_MS;
    const isUnknown = unknown.has(id);
    const auto = str(r.details.reason) === PAID_AFTER_END;
    out.push({
      requestId: id,
      requestedAt: r.createdAt,
      amountCents: amount,
      state: settled
        ? "resolved"
        : isUnknown && ref === null
          ? "unknown"
          : live || (auto && ref === null)
            ? "outstanding"
            : "resolved",
      blocking: !settled && live,
      unknownAt: unknown.get(id)?.at ?? null,
      idempotencyKey: unknown.get(id)?.key ?? null,
      refundRef: ref,
      reason: auto ? PAID_AFTER_END : null,
    });
  }
  return out;
}

/** A refund as the provider lists it (`StripeClient.listRefunds`, normalized). */
export interface ProviderRefund {
  id: string;
  amountCents: number;
  currency: string;
  status: "pending" | "succeeded" | "failed" | "canceled";
  metadata: Record<string, string>;
}

export type ReconcileDecision = "succeeded" | "pending" | "failed" | "none" | "mismatch";

/** Metadata keys a refund may carry its request's idempotency key under. */
const KEY_FIELDS = ["refund_key", "idempotency_key"] as const;
const keyOf = (r: ProviderRefund): string | null => {
  for (const k of KEY_FIELDS) if (r.metadata[k]) return r.metadata[k] ?? null;
  return null;
};

/**
 * What the provider's refunds say about one unknown request (pure). `claimed`: refund ids that
 * belong elsewhere (posted, or named by another request's markers).
 */
export function decideReconcile(
  request: { amountCents: number; currency: string; idempotencyKey: string | null },
  refunds: readonly ProviderRefund[],
  claimed: ReadonlySet<string>,
): { decision: ReconcileDecision; refundRef: string | null } {
  const open = refunds.filter((r) => !claimed.has(r.id));
  const byStatus = (r: ProviderRefund): ReconcileDecision =>
    r.status === "succeeded" ? "succeeded" : r.status === "pending" ? "pending" : "failed";
  if (request.idempotencyKey !== null) {
    const keyed = open.find((r) => keyOf(r) === request.idempotencyKey);
    if (keyed) return { decision: byStatus(keyed), refundRef: keyed.id };
  }
  // Refunds carrying another request's key are not this one's.
  const unkeyed = open.filter((r) => keyOf(r) === null);
  const same = unkeyed.filter((r) => r.amountCents === request.amountCents && r.currency === request.currency);
  // A live one of the amount first: a failed attempt and its successful retry may both be listed.
  const best = same.find((r) => r.status === "succeeded") ?? same.find((r) => r.status === "pending") ?? same[0];
  if (best) return { decision: byStatus(best), refundRef: best.id };
  if (unkeyed.length > 0) return { decision: "mismatch", refundRef: null };
  return { decision: "none", refundRef: null };
}

/** The API's `classifyRefundError`: a definite refusal releases, anything else may have reached Stripe. */
export function classifyRefundError(err: unknown): "failed" | "unknown" {
  if (isDefiniteRefusal(err) || err instanceof RangeError || err instanceof AdapterUnavailableError) return "failed";
  return "unknown";
}

// ------------------------------------------------------------ the provider port

/** What this job asks of the payment provider; injectable, because stripe-mock is stateless. */
export interface RefundPort {
  provider: string;
  /** Every refund of a PaymentIntent, or null when this provider cannot list them. */
  listRefunds: ((paymentIntent: string) => Promise<ProviderRefund[]>) | null;
  refund: ((r: RefundRequest) => Promise<{ providerRef: string }>) | null;
}

type ListingAdapter = PaymentAdapter & { listRefunds?: (paymentIntent: string) => Promise<unknown[]> };

function normalizeRefund(v: unknown): ProviderRefund | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id) ?? str(o.providerRef);
  const amount = typeof o.amount === "number" ? o.amount : typeof o.amountCents === "number" ? o.amountCents : null;
  const currency = str(o.currency);
  if (!id || amount === null || !currency) return null;
  const s = str(o.status);
  const status = s === "succeeded" || s === "failed" || s === "canceled" ? s : "pending";
  const meta = typeof o.metadata === "object" && o.metadata !== null ? (o.metadata as Record<string, unknown>) : {};
  const metadata: Record<string, string> = {};
  for (const [k, val] of Object.entries(meta)) if (typeof val === "string") metadata[k] = val;
  return { id, amountCents: amount, currency: currency.toLowerCase(), status, metadata };
}

const portEnv = paymentsEnv.pick({
  PAYMENTS_PROVIDER: true,
  MANUAL_PAYMENT_INSTRUCTIONS: true,
  STRIPE_SECRET_KEY: true,
  STRIPE_API_BASE: true,
});

/**
 * The instance's provider. The adapter has no refund listing yet (contract request: an optional
 * `listRefunds` on `PaymentAdapter` over `StripeClient.listRefunds`); until it has, unknown
 * requests stay unknown here and settle by webhook, by the treasurer or at the TTL.
 */
export function refundPortFromEnv(source: Record<string, string | undefined> = process.env): RefundPort {
  const env = loadEnv(portEnv, source);
  let adapter: ListingAdapter;
  try {
    adapter = createAdapter(env);
  } catch {
    return { provider: env.PAYMENTS_PROVIDER, listRefunds: null, refund: null };
  }
  const list = adapter.listRefunds?.bind(adapter);
  return {
    provider: adapter.provider,
    listRefunds: list
      ? async (pi) =>
          (await list(pi)).flatMap((r) => {
            const n = normalizeRefund(r);
            return n ? [n] : [];
          })
      : null,
    refund: adapter.refund ? adapter.refund.bind(adapter) : null,
  };
}

// ------------------------------------------------------------ the passes

async function historyOf(tx: Executor, paymentId: string) {
  const markers = await tx
    .select({ action: auditLog.action, createdAt: auditLog.createdAt, details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectType, "payment"),
        eq(auditLog.subjectId, paymentId),
        inArray(auditLog.action, [...MARKERS]),
      ),
    );
  const postings = await tx
    .select({ providerRef: disputes.providerRef, amountCents: disputes.amountCents, createdAt: disputes.createdAt })
    .from(disputes)
    .where(and(eq(disputes.paymentId, paymentId), eq(disputes.kind, "refund")));
  return { markers, postings };
}

/** Refund ids already accounted for: posted, or named by a marker. */
function claimedRefs(markers: readonly RefundMarker[], postings: readonly RefundPosting[]): Set<string> {
  const out = new Set<string>();
  for (const p of postings) if (p.providerRef) out.add(p.providerRef);
  for (const mk of markers) {
    const ref = str(mk.details.refundRef);
    if (ref) out.add(ref);
  }
  return out;
}

async function writeMarker(
  tx: Executor,
  p: { id: string; channelId: string | null },
  action: string,
  details: Record<string, string | number>,
  at: Date,
  reason = "",
) {
  await tx.insert(auditLog).values({
    id: uuidv7(at.getTime()),
    actorType: "system",
    actorId: null,
    action,
    subjectType: "payment",
    subjectId: p.id,
    channelId: p.channelId,
    reason,
    details,
    createdAt: at,
  });
}

export interface ReconcileResult {
  requests: number;
  succeeded: number;
  pending: number;
  failed: number;
  none: number;
  mismatch: number;
  unanswered: number;
  unsupported: number;
}

/** Pass 1: settle what the provider can tell us about requests whose outcome is unknown. */
export async function reconcileUnknownRefunds(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  port: RefundPort,
): Promise<ReconcileResult> {
  const now = ctx.now();
  const out: ReconcileResult = {
    requests: 0,
    succeeded: 0,
    pending: 0,
    failed: 0,
    none: 0,
    mismatch: 0,
    unanswered: 0,
    unsupported: 0,
  };
  const since = new Date(now.getTime() - RECONCILE_WINDOW_MS).toISOString();
  const ripe = new Date(now.getTime() - RECONCILE_MIN_AGE_MS).toISOString();
  // Payments with an unknown request no failure or resolve released yet, oldest unknown first, so
  // settled ones never fill the batch and every open one gets its turn.
  const rows = await ctx.db.execute<{ paymentId: string }>(sql`
    select u.subject_id as "paymentId" from audit_log u
    where u.action = ${REFUND_OUTCOME_UNKNOWN} and u.subject_type = 'payment'
      and u.created_at > ${since}::timestamptz and u.created_at <= ${ripe}::timestamptz
      and not exists (select 1 from audit_log x where x.subject_type = 'payment' and x.subject_id = u.subject_id
        and x.action in (${REFUND_REQUEST_FAILED}, ${REFUND_REQUEST_RESOLVED})
        and x.details->>'requestId' = u.details->>'requestId')
    group by u.subject_id
    order by min(u.created_at)
    limit ${RECONCILE_BATCH}`);
  const count = (outcome: keyof ReconcileResult) => {
    out[outcome]++;
    reconcileMetrics.outcomes.add(1, { outcome });
  };
  for (const { paymentId } of rows) {
    const [p] = await ctx.db.select().from(payments).where(eq(payments.id, paymentId));
    if (!p) continue;
    const h = await historyOf(ctx.db, p.id);
    const open = requestStates(h.markers, h.postings, now).filter(
      (s) =>
        s.state === "unknown" &&
        now.getTime() - s.requestedAt.getTime() <= RECONCILE_WINDOW_MS &&
        s.unknownAt !== null &&
        now.getTime() - s.unknownAt.getTime() >= RECONCILE_MIN_AGE_MS,
    );
    if (open.length === 0) continue;
    if (!port.listRefunds || port.provider !== p.provider) {
      for (const _ of open) count("unsupported");
      continue;
    }
    let refunds: ProviderRefund[];
    try {
      refunds = await port.listRefunds(p.providerRef);
    } catch (err) {
      ctx.logger.warn("refund reconcile: the provider did not answer", {
        paymentId: p.id,
        error: err instanceof Error ? err.name : typeof err,
      });
      for (const _ of open) count("unanswered");
      continue;
    }
    for (const s of open) {
      out.requests++;
      const { decision, refundRef } = decideReconcile(
        { amountCents: s.amountCents ?? 0, currency: p.currency, idempotencyKey: s.idempotencyKey },
        refunds,
        claimedRefs(h.markers, h.postings),
      );
      if (decision === "pending") {
        count("pending");
        continue;
      }
      if (decision === "succeeded") {
        // Never posted from here: the ledger follows the provider's charge.refunded only.
        ctx.logger.warn("refund reconcile: refunded at the provider but not posted; is its webhook lost?", {
          paymentId: p.id,
          requestId: s.requestId,
        });
        count("succeeded");
        continue;
      }
      if (decision === "mismatch") {
        ctx.logger.warn("refund reconcile: the provider lists refunds of other amounts only; left for the treasurer", {
          paymentId: p.id,
          requestId: s.requestId,
        });
        count("mismatch");
        continue;
      }
      // Failed, or definitely none: release it, unless something settled it meanwhile.
      const wrote = await ctx.db.transaction(async (tx) => {
        const [locked] = await tx.select().from(payments).where(eq(payments.id, p.id)).for("update");
        if (!locked) return false;
        const again = await historyOf(tx, p.id);
        const still = requestStates(again.markers, again.postings, now).find((x) => x.requestId === s.requestId);
        if (!still || still.state !== "unknown") return false;
        await writeMarker(
          tx,
          locked,
          REFUND_REQUEST_FAILED,
          {
            requestId: s.requestId,
            reason: decision === "none" ? "reconciled_none" : "reconciled_failed",
            ...(refundRef ? { refundRef } : {}),
          },
          now,
        );
        return true;
      });
      // Settled meanwhile (a webhook under the same lock): nothing to count.
      if (wrote) count(decision);
    }
  }
  return out;
}

export interface SweepResult {
  candidates: number;
  requested: number;
  unknown: number;
  failed: number;
  skipped: number;
  listed: number;
}

/** Pass 2: the durable trigger for automatic refunds the API's after-commit hook missed. */
export async function sweepPaidAfterEnd(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  port: RefundPort,
): Promise<SweepResult> {
  const now = ctx.now();
  const out: SweepResult = { candidates: 0, requested: 0, unknown: 0, failed: 0, skipped: 0, listed: 0 };
  const newest = new Date(now.getTime() - SWEEP_MIN_AGE_MS).toISOString();
  const oldest = new Date(now.getTime() - SWEEP_MAX_AGE_MS).toISOString();
  // Two shapes of "booked after the end": a renewal or first invoice booked for a subscription that
  // had already ended, and a gift paid after its window, booked without starting any of its gift
  // subscriptions (none ever got a period; contract request 7 books it that way).
  const rows = await ctx.db.execute<{ id: string }>(sql`
    select id from (
      select p.id, p.created_at as booked_at from payments p join subscriptions s on s.id = p.subscription_id
      where p.provider = 'stripe' and p.kind = 'subscription' and not p.gift
        and p.status in ('succeeded', 'partially_refunded') and p.refunded_cents < p.amount_cents
        and s.status not in ('active', 'past_due', 'incomplete')
        and p.created_at >= s.updated_at - make_interval(secs => ${BOOKED_AFTER_END_SKEW_MS / 1000})
      union all
      select p.id, coalesce(p.succeeded_at, p.updated_at) as booked_at from payments p
      where p.provider = 'stripe' and p.kind = 'subscription' and p.gift
        and p.status in ('succeeded', 'partially_refunded') and p.refunded_cents < p.amount_cents
        and exists (select 1 from subscriptions g where g.gift_payment_id = p.id)
        and not exists (select 1 from subscriptions g where g.gift_payment_id = p.id
          and (g.current_period_start is not null or g.status in ('active', 'past_due', 'incomplete')))
    ) c
    where c.booked_at <= ${newest}::timestamptz and c.booked_at > ${oldest}::timestamptz
      and not exists (select 1 from audit_log a where a.subject_type = 'payment' and a.subject_id = c.id::text
        and a.action = ${REFUND_REQUESTED} and a.details->>'reason' = ${PAID_AFTER_END})
    order by c.booked_at
    limit ${RECONCILE_BATCH}`);
  for (const { id } of rows) {
    out.candidates++;
    const r = await autoRefundOne(ctx, port, id, now);
    out[r]++;
    reconcileMetrics.autoRefunds.add(1, { outcome: r });
  }
  return out;
}

async function autoRefundOne(
  ctx: Pick<WorkerContext, "db" | "logger">,
  port: RefundPort,
  paymentId: string,
  now: Date,
): Promise<"requested" | "unknown" | "failed" | "skipped" | "listed"> {
  const requestId = uuidv7(now.getTime());
  const claimed = await ctx.db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
    if (!p || !["succeeded", "partially_refunded"].includes(p.status)) return null;
    const rest = p.amountCents - p.refundedCents;
    if (rest <= 0) return null;
    const h = await historyOf(tx, p.id);
    const states = requestStates(h.markers, h.postings, now);
    if (states.some((s) => s.reason === PAID_AFTER_END) || states.some((s) => s.blocking)) return null;
    await writeMarker(
      tx,
      p,
      REFUND_REQUESTED,
      { requestId, amountCents: rest, provider: p.provider, reason: PAID_AFTER_END },
      now,
    );
    return { p, rest };
  });
  if (!claimed) return "skipped";
  const { p, rest } = claimed;
  if (!port.refund || port.provider !== p.provider) {
    // Listed for the treasurer, who refunds it by hand.
    ctx.logger.warn("automatic refund listed for the treasurer: no provider refund here", { paymentId: p.id });
    return "listed";
  }
  const idempotencyKey = `refund-${p.id}-${p.refundedCents}-${rest}`;
  try {
    const done = await port.refund({ paymentId: p.id, providerRef: p.providerRef, amountCents: rest, idempotencyKey });
    await writeMarker(
      ctx.db,
      p,
      REFUND_SUBMITTED,
      { requestId, refundRef: done.providerRef },
      new Date(now.getTime() + 1),
    );
    ctx.logger.info("automatic refund requested by the sweep", { paymentId: p.id });
    return "requested";
  } catch (err) {
    const unknown = classifyRefundError(err) === "unknown";
    await writeMarker(
      ctx.db,
      p,
      unknown ? REFUND_OUTCOME_UNKNOWN : REFUND_REQUEST_FAILED,
      unknown ? { requestId, idempotencyKey } : { requestId },
      new Date(now.getTime() + 1),
    );
    ctx.logger.warn("automatic refund by the sweep not submitted", {
      paymentId: p.id,
      outcome: unknown ? "unknown" : "failed",
      error: err instanceof Error ? err.name : typeof err,
    });
    return unknown ? "unknown" : "failed";
  }
}

/** One run: both passes. */
export async function runRefundReconcile(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  port: RefundPort,
): Promise<{ reconcile: ReconcileResult; sweep: SweepResult }> {
  const reconcile = await reconcileUnknownRefunds(ctx, port);
  const sweep = await sweepPaidAfterEnd(ctx, port);
  return { reconcile, sweep };
}
