// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payment breakdowns (feature-wins §4.1), derived from `PaymentMetaV2` and the payment's ledger
 * transactions, and the settlement invariant the nightly `money-reconcile` job checks. Pure: the
 * API and the worker load the rows and hand them in.
 *
 * Sign convention of the lines (not the ledger's debit/credit one): gross-side lines (`tax`,
 * `creator`, `coop_share`) are positive and sum to gross; `reversal` lines carry the sign of the
 * reversal (negative for refunds and chargebacks, positive for a won chargeback) and sum to its
 * `revenueGrossCents`; fees (`processor_fee`, `dispute_fee`) are positive co-op expenses outside
 * gross (a returned dispute fee is a negative `dispute_fee`); `coop_net` is derived and signed.
 */
import type { BREAKDOWN_COMPONENTS, BREAKDOWN_EVENT_KINDS, BREAKDOWN_LINE_KINDS } from "@commonair/contracts/enums";
import { accounts } from "./accounts.ts";
import { PaymentMetaV2, ReversalMetaV2 } from "./meta.ts";
import { holdReleaseDueAt } from "./rules.ts";

export type BreakdownLineKind = (typeof BREAKDOWN_LINE_KINDS)[number];
export type BreakdownComponent = (typeof BREAKDOWN_COMPONENTS)[number];
export type BreakdownEventKind = (typeof BREAKDOWN_EVENT_KINDS)[number];

export class BreakdownError extends Error {
  override name = "BreakdownError";
}

/** One ledger entry of a payment's transaction. `code` may be a chart code or a stored `code@currency`. */
export interface BreakdownEntry {
  code: string;
  amountCents: number;
  memo?: string | null;
}

/** One ledger transaction with `ref_type = 'payment'` and `ref_id` = the payment. */
export interface BreakdownTransaction {
  id: string;
  kind: string;
  occurredAt: Date;
  metadata: unknown;
  entries: readonly BreakdownEntry[];
}

/** The `payments` row facts the builder needs. */
export interface BreakdownPaymentFacts {
  id: string;
  kind: "subscription" | "tip" | "membership_share";
  currency: string;
  /** `payments.succeeded_at`; the payment posting's `occurredAt` when null. */
  succeededAt: Date | null;
}

export interface BreakdownMoney {
  cents: number;
  currency: string;
}

export interface BuiltBreakdownLine {
  kind: BreakdownLineKind;
  amount: BreakdownMoney;
  recipientUserId: string | null;
  component: BreakdownComponent | null;
  transactionId: string | null;
}

export interface BuiltBreakdownEvent {
  kind: BreakdownEventKind;
  at: string;
  amount: BreakdownMoney | null;
  transactionId: string;
}

/** `PaymentBreakdown` without the DTO-only fields (channel, viewer role, payer, cut source dates). */
export interface BuiltBreakdown {
  paymentId: string;
  kind: BreakdownPaymentFacts["kind"];
  gross: BreakdownMoney;
  succeededAt: string;
  lines: BuiltBreakdownLine[];
  holdReleasesAt: string | null;
  holdReleasedAt: string | null;
  /** The cut recorded in the posting (`cutHistoryId` null = the founding seed). */
  cut: { historyId: string | null; streamerShare: number; coopShare: number };
  timeline: BuiltBreakdownEvent[];
}

const GROSS_SIDE: ReadonlySet<BreakdownLineKind> = new Set(["tax", "creator", "coop_share"]);
const FEE_KINDS: ReadonlySet<BreakdownLineKind> = new Set(["processor_fee", "dispute_fee"]);
const REVERSAL_EVENTS: Readonly<Record<string, BreakdownEventKind>> = {
  refund: "refunded",
  chargeback: "charged_back",
  chargeback_reversal: "chargeback_won",
};

/** A stored account code (`code@currency`) as its chart code. */
function chartCode(code: string): string {
  const at = code.lastIndexOf("@");
  return at > 0 ? code.slice(0, at) : code;
}

const byTime = (a: BreakdownTransaction, b: BreakdownTransaction) =>
  a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The payment's own posting (`kind = 'payment'`) and its parsed v2 metadata. */
function paymentPosting(transactions: readonly BreakdownTransaction[]): {
  tx: BreakdownTransaction;
  meta: PaymentMetaV2;
} {
  const postings = transactions.filter((t) => t.kind === "payment");
  const [tx] = postings;
  if (!tx || postings.length > 1) throw new BreakdownError("a breakdown needs exactly one payment posting");
  const parsed = PaymentMetaV2.safeParse(tx.metadata);
  // There is no v1 reader (ADR 0013 decision 2): staging was reset when v2 was frozen.
  if (!parsed.success) throw new BreakdownError(`payment posting ${tx.id} has no PaymentMeta v2`);
  return { tx, meta: parsed.data };
}

function parseReversal(tx: BreakdownTransaction): ReversalMetaV2 {
  const parsed = ReversalMetaV2.safeParse(tx.metadata);
  if (!parsed.success) throw new BreakdownError(`${tx.kind} posting ${tx.id} has no ReversalMeta v2`);
  const m = parsed.data;
  const creator = m.shares.reduce((s, x) => s + x.creatorCents, 0);
  if (creator !== m.creatorCents || m.taxCents + m.creatorCents + m.coopCents !== m.revenueGrossCents) {
    throw new BreakdownError(`${tx.kind} posting ${tx.id}: its components do not sum to its amount`);
  }
  return m;
}

/** The account a payment's money arrived on and left from (`settlementAccount` in the rules). */
export function settlementCode(meta: Pick<PaymentMetaV2, "provider" | "settlement">): string {
  return meta.settlement === "cash" ? accounts.cash(meta.provider) : accounts.providerReceivable(meta.provider);
}

/**
 * Build the breakdown of one payment from its transactions. Throws `BreakdownError` when the
 * payment posting is missing, duplicated or not v2, or a reversal's metadata is unusable.
 * Transactions of other kinds (none are posted today) add no line and no timeline item, so they
 * show up as a reconciliation mismatch instead of being explained away.
 */
export function buildBreakdown(
  payment: BreakdownPaymentFacts,
  transactions: readonly BreakdownTransaction[],
  holdDays: number,
): BuiltBreakdown {
  const { tx: paid, meta } = paymentPosting(transactions);
  const currency = payment.currency;
  const money = (cents: number): BreakdownMoney => ({ cents, currency });
  const shares = [...meta.shares].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const creatorTotal = shares.reduce((s, x) => s + x.creatorCents, 0);
  if (
    creatorTotal !== meta.creatorCents ||
    meta.taxCents + meta.creatorCents + meta.coopCents !== meta.revenueGrossCents
  ) {
    throw new BreakdownError(`payment posting ${paid.id}: its split does not sum to gross`);
  }

  const lines: BuiltBreakdownLine[] = [];
  const line = (
    kind: BreakdownLineKind,
    cents: number,
    transactionId: string | null,
    extra: { recipientUserId?: string; component?: BreakdownComponent } = {},
  ) =>
    lines.push({
      kind,
      amount: money(cents),
      recipientUserId: extra.recipientUserId ?? null,
      component: extra.component ?? null,
      transactionId,
    });

  if (meta.taxCents !== 0) line("tax", meta.taxCents, paid.id);
  for (const s of shares) line("creator", s.creatorCents, paid.id, { recipientUserId: s.userId });
  line("coop_share", meta.coopCents, paid.id);
  line("processor_fee", meta.feeCents, paid.id);

  const timeline: BuiltBreakdownEvent[] = [];
  let releasedAt: Date | null = null;
  for (const tx of [...transactions].sort(byTime)) {
    const at = tx.occurredAt.toISOString();
    if (tx.kind === "payment") {
      timeline.push({ kind: "paid", at, amount: money(meta.revenueGrossCents), transactionId: tx.id });
      continue;
    }
    if (tx.kind === "hold_release") {
      // What left the hold: the debit on the creator-hold account.
      const cents = tx.entries.filter((e) => e.amountCents > 0).reduce((s, e) => s + e.amountCents, 0);
      timeline.push({ kind: "hold_released", at, amount: money(cents), transactionId: tx.id });
      releasedAt ??= tx.occurredAt;
      continue;
    }
    const event = REVERSAL_EVENTS[tx.kind];
    if (!event) continue;
    const r = parseReversal(tx);
    if (r.taxCents !== 0) line("reversal", r.taxCents, tx.id, { component: "tax" });
    const reversed = [...r.shares].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
    for (const s of reversed) {
      if (s.creatorCents !== 0)
        line("reversal", s.creatorCents, tx.id, { component: "creator", recipientUserId: s.userId });
    }
    if (r.coopCents !== 0) line("reversal", r.coopCents, tx.id, { component: "coop_share" });
    if ((r.disputeFeeCents ?? 0) !== 0) line("dispute_fee", r.disputeFeeCents ?? 0, tx.id);
    // A returned dispute fee lowers the co-op's expense.
    if ((r.feeRefundCents ?? 0) !== 0) line("dispute_fee", -(r.feeRefundCents ?? 0), tx.id);
    timeline.push({ kind: event, at, amount: money(r.revenueGrossCents), transactionId: tx.id });
  }

  line("coop_net", coopNet(lines), null);

  return {
    paymentId: payment.id,
    kind: payment.kind,
    gross: money(meta.revenueGrossCents),
    succeededAt: (payment.succeededAt ?? paid.occurredAt).toISOString(),
    lines,
    // The hold runs from the posting (as `releaseDueHolds` counts it), not from the row's timestamp.
    holdReleasesAt: releasedAt ? null : holdReleaseDueAt(paid.occurredAt, holdDays).toISOString(),
    holdReleasedAt: releasedAt ? releasedAt.toISOString() : null,
    cut: { historyId: meta.cutHistoryId, streamerShare: meta.streamerShare, coopShare: meta.coopShare },
    timeline,
  };
}

/** Co-op share − its reversals − processor fee − dispute fees + returned fees (signed). */
export function coopNet(lines: readonly Pick<BuiltBreakdownLine, "kind" | "amount" | "component">[]): number {
  let net = 0;
  for (const l of lines) {
    if (l.kind === "coop_share") net += l.amount.cents;
    else if (l.kind === "reversal" && l.component === "coop_share") net += l.amount.cents;
    else if (FEE_KINDS.has(l.kind)) net -= l.amount.cents;
  }
  return net;
}

/** Signed sum of every entry on the payment's settlement account, across all its transactions. */
export function settlementMovement(transactions: readonly BreakdownTransaction[]): number {
  const { meta } = paymentPosting(transactions);
  const code = settlementCode(meta);
  let sum = 0;
  for (const tx of transactions) {
    for (const e of tx.entries) if (chartCode(e.code) === code) sum += e.amountCents;
  }
  return sum;
}

/** What the breakdown says moved through settlement: gross side + reversals − fees (net of returns). */
export function breakdownSettlement(b: Pick<BuiltBreakdown, "lines">): number {
  let total = 0;
  for (const l of b.lines) {
    if (GROSS_SIDE.has(l.kind) || l.kind === "reversal") total += l.amount.cents;
    else if (FEE_KINDS.has(l.kind)) total -= l.amount.cents;
  }
  return total;
}

/** The breakdown and the ledger agree on the money that moved through settlement. */
export function reconciles(b: Pick<BuiltBreakdown, "lines">, movement: number): boolean {
  return breakdownSettlement(b) === movement;
}
