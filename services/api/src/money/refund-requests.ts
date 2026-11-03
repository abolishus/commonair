// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.treasurer.refundRequests.{list,resolve}` (ADR 0007 decision 3): provider refund requests
 * with their audit markers (`stripe-refunds.ts`), and the audited resolve for a request whose
 * outcome Stripe never told us.
 *
 * `list` filters by state: `outstanding` (still blocking a new request, or an automatic refund
 * nothing was sent for, which stays listed past the TTL), `unknown` (the provider's
 * answer is unknown, listed even after the TTL) or `all`. Newest request first, paged by the
 * request marker's id (UUIDv7, time-ordered).
 *
 * `resolve` records what the treasurer found at Stripe for a request nobody settled. It is refused
 * in the request's first 15 minutes, while the reconciler (`refund-reconcile`) still asks Stripe,
 * and for a request Stripe answered with a refund id (its refund event settles it).
 */
import { and, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { REFUND_MARKER_ACTIONS, type RefundMarkerAction } from "@commonair/contracts/enums";
import type { RefundRequestView } from "@commonair/contracts/dto";
import { type Executor, schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { decodeCursor, encodeCursor } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import {
  PAID_AFTER_END,
  REFUND_MARKER_ACTIONS_READ,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUESTED,
  REFUND_REQUEST_FAILED,
  REFUND_REQUEST_RESOLVED,
  REFUND_REQUEST_TTL_MS,
  REFUND_RESOLVE_GRACE_MS,
  type RefundMarker,
  type RefundPosting,
  type RefundRequestStatus,
  paymentRefundStates,
  refundRequestStates,
} from "./stripe-refunds.ts";

const { auditLog, payments, disputes, users } = schema;

type RequestRow = typeof auditLog.$inferSelect;
type Filter = "outstanding" | "unknown" | "all";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isIdCursor = (v: Record<string, unknown>): v is { id: string } => typeof v.id === "string" && UUID.test(v.id);
const isContractMarker = (a: string): a is RefundMarkerAction =>
  (REFUND_MARKER_ACTIONS as readonly string[]).includes(a);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Request markers scanned per query while a filtered page fills. */
const SCAN_BATCH = 200;

/** The views of these request markers, from their payments' full history (one query per table). */
async function viewsFor(db: Executor, rows: readonly RequestRow[], now: Date): Promise<Map<string, RefundRequestView>> {
  const out = new Map<string, RefundRequestView>();
  if (rows.length === 0) return out;
  const paymentIds = [...new Set(rows.map((r) => r.subjectId))].filter((id) => UUID.test(id));
  if (paymentIds.length === 0) return out;
  const [paymentRows, markerRows, postingRows] = await Promise.all([
    db.select().from(payments).where(inArray(payments.id, paymentIds)),
    db
      .select({
        subjectId: auditLog.subjectId,
        action: auditLog.action,
        createdAt: auditLog.createdAt,
        details: auditLog.details,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.subjectType, "payment"),
          inArray(auditLog.subjectId, paymentIds),
          inArray(auditLog.action, [...REFUND_MARKER_ACTIONS_READ]),
        ),
      ),
    db
      .select({
        paymentId: disputes.paymentId,
        providerRef: disputes.providerRef,
        amountCents: disputes.amountCents,
        createdAt: disputes.createdAt,
      })
      .from(disputes)
      .where(and(inArray(disputes.paymentId, paymentIds), eq(disputes.kind, "refund"))),
  ]);
  const actorIds = [...new Set(rows.flatMap((r) => (r.actorType === "admin" && r.actorId ? [r.actorId] : [])))];
  const actors = actorIds.length
    ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, actorIds))
    : [];
  const actorOf = new Map(actors.map((a) => [a.id, a]));
  const paymentOf = new Map(paymentRows.map((p) => [p.id, p]));
  const markersOf = new Map<string, RefundMarker[]>();
  for (const m of markerRows) {
    const list = markersOf.get(m.subjectId) ?? [];
    list.push(m);
    markersOf.set(m.subjectId, list);
  }
  const postingsOf = new Map<string, RefundPosting[]>();
  for (const d of postingRows) {
    const list = postingsOf.get(d.paymentId) ?? [];
    list.push(d);
    postingsOf.set(d.paymentId, list);
  }
  const statesOf = new Map<string, Map<string, RefundRequestStatus>>();
  for (const id of paymentIds) {
    const states = refundRequestStates(markersOf.get(id) ?? [], postingsOf.get(id) ?? [], now);
    statesOf.set(id, new Map(states.map((s) => [s.requestId, s])));
  }
  for (const r of rows) {
    const p = paymentOf.get(r.subjectId);
    const requestId = str(r.details.requestId);
    const s = requestId ? statesOf.get(r.subjectId)?.get(requestId) : undefined;
    if (!p || !requestId || !s) continue;
    const own = (markersOf.get(r.subjectId) ?? [])
      .filter((m) => {
        if (!isContractMarker(m.action)) return false;
        const id = str(m.details.requestId);
        if (id !== null) return id === requestId;
        // Stripe's refund.failed before it was tied to a request: by the refund id.
        return m.action === REFUND_REQUEST_FAILED && s.refundRef !== null && str(m.details.refundRef) === s.refundRef;
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const actor = r.actorId ? actorOf.get(r.actorId) : undefined;
    out.set(r.id, {
      id: requestId,
      paymentId: p.id,
      paymentKind: p.kind,
      provider: p.provider,
      amount: { cents: p.amountCents, currency: p.currency },
      requested: { cents: s.amountCents ?? 0, currency: p.currency },
      state: s.state,
      reason: s.reason,
      requestedBy: actor ? { id: actor.id, username: actor.username } : null,
      markers: own.flatMap((m) => (isContractMarker(m.action) ? [{ action: m.action, at: iso(m.createdAt) }] : [])),
      createdAt: iso(r.createdAt),
    });
  }
  return out;
}

function prefilter(state: Filter, now: Date) {
  if (state === "outstanding")
    // Automatic refunds nothing was sent for stay outstanding past the TTL (`refundRequestStates`).
    return or(
      gt(auditLog.createdAt, new Date(now.getTime() - REFUND_REQUEST_TTL_MS)),
      sql`${auditLog.details}->>'reason' = ${PAID_AFTER_END}`,
    );
  if (state === "unknown")
    return sql`exists (select 1 from audit_log u where u.action = ${REFUND_OUTCOME_UNKNOWN}
      and u.subject_type = 'payment' and u.subject_id = ${auditLog.subjectId}
      and u.details->>'requestId' = ${auditLog.details}->>'requestId')`;
  return undefined;
}

async function requestMarker(db: Executor, requestId: string): Promise<RequestRow | null> {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, REFUND_REQUESTED),
        eq(auditLog.subjectType, "payment"),
        sql`${auditLog.details}->>'requestId' = ${requestId}`,
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRefundRequests(
  deps: Pick<Deps, "db">,
  input: { state: Filter; limit: number; cursor?: string | undefined },
  now: Date,
): Promise<{ items: RefundRequestView[]; nextCursor: string | null }> {
  let after = decodeCursor(input.cursor, isIdCursor)?.id ?? null;
  const found: { rowId: string; view: RefundRequestView }[] = [];
  for (;;) {
    const rows = await deps.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, REFUND_REQUESTED),
          eq(auditLog.subjectType, "payment"),
          prefilter(input.state, now),
          after ? lt(auditLog.id, after) : undefined,
        ),
      )
      .orderBy(desc(auditLog.id))
      .limit(SCAN_BATCH);
    const views = await viewsFor(deps.db, rows, now);
    for (const r of rows) {
      const v = views.get(r.id);
      if (!v) continue;
      if (input.state === "outstanding" && v.state !== "outstanding" && v.state !== "unknown") continue;
      if (input.state === "outstanding" && v.state === "unknown") {
        // Unknown requests block too while live; past the TTL they belong to the `unknown` list only.
        if (now.getTime() - Date.parse(v.createdAt) > REFUND_REQUEST_TTL_MS) continue;
      }
      if (input.state === "unknown" && v.state !== "unknown") continue;
      found.push({ rowId: r.id, view: v });
      if (found.length > input.limit) break;
    }
    const last = rows.at(-1);
    if (found.length > input.limit || rows.length < SCAN_BATCH || !last) break;
    after = last.id;
  }
  const page = found.slice(0, input.limit);
  const tail = page.at(-1);
  return {
    items: page.map((f) => f.view),
    nextCursor: found.length > input.limit && tail ? encodeCursor({ id: tail.rowId }) : null,
  };
}

export const treasurerRefundRequestHandlers = {
  list: os.money.treasurer.refundRequests.list.handler(async ({ context, input }) => {
    requireCaller(context);
    return listRefundRequests(context.deps, input, context.deps.now());
  }),

  resolve: os.money.treasurer.refundRequests.resolve.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const marker = await requestMarker(deps.db, input.requestId);
    if (!marker || !UUID.test(marker.subjectId)) throw notFound("Refund request not found");
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      // The payment's row lock orders this against the webhook and the reconciler.
      const [p] = await tx.select().from(payments).where(eq(payments.id, marker.subjectId)).for("update");
      if (!p) throw notFound("Refund request not found");
      const s = (await paymentRefundStates(tx, p.id, now)).find((x) => x.requestId === input.requestId);
      if (!s || s.state === "resolved") throw conflict("This refund request is already settled");
      if (s.refundRef !== null)
        throw conflict("The payment provider answered this request; its refund event settles it");
      if (now.getTime() - s.requestedAt.getTime() < REFUND_RESOLVE_GRACE_MS)
        throw precondition(
          "refund_reconciling",
          "The payment provider is still being asked about this refund; try again in a few minutes",
        );
      await audit(tx, {
        actorType: "admin",
        actorId: caller.user.id,
        action: REFUND_REQUEST_RESOLVED,
        subjectType: "payment",
        subjectId: p.id,
        channelId: p.channelId,
        reason: input.note.trim(),
        details: { requestId: input.requestId, outcome: input.outcome },
      });
    });
    const view = (await viewsFor(deps.db, [marker], deps.now())).get(marker.id);
    if (!view) throw notFound("Refund request not found");
    return view;
  }),
};
