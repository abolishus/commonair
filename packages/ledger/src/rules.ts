// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Posting rules: pure functions from a business event to a balanced `Posting`.
 * Sign convention: debits positive, credits negative. Every rule validates its result, so a
 * rule can never hand the poster an unbalanced set.
 *
 * Hold lots: every entry on a `liability:creator-hold` account carries the memo
 * `hold:<paymentId>`, so the hold is tracked per payment ("lot") and a release can only ever
 * release what is still attributable to that payment.
 */
import { accounts, assertCurrency, describeAccount } from "./accounts.ts";
import { assertCents, floorShare, mulDivFloor, negate } from "./math.ts";
import { type Posting, type PostingEntry, nonZero, validatePosting } from "./posting.ts";

/** The `platform.cut` governance setting. */
export interface PlatformCut {
  streamerShare: number;
  coopShare: number;
}
export const DEFAULT_PLATFORM_CUT: PlatformCut = { streamerShare: 0.9, coopShare: 0.1 };

/** Where money from a payment sits: settled cash, or still owed by the provider. */
export type Settlement = "cash" | "receivable";

export class PayoutBelowMinimumError extends Error {
  override name = "PayoutBelowMinimumError";
}
export class InsufficientBalanceError extends Error {
  override name = "InsufficientBalanceError";
}

/** The memo that attributes a hold entry to one payment. */
export const holdMemo = (paymentId: string) => `hold:${paymentId}`;

export function assertCut(cut: PlatformCut): void {
  const ok = (x: number) => Number.isFinite(x) && x >= 0 && x <= 1;
  if (!ok(cut.streamerShare) || !ok(cut.coopShare) || Math.abs(cut.streamerShare + cut.coopShare - 1) > 1e-9) {
    throw new RangeError("platform cut shares must be within [0, 1] and sum to 1");
  }
}

/**
 * Split net-of-tax revenue: the creator gets floor(net × streamerShare), the co-op the
 * remainder, so the parts always sum to `net` exactly.
 */
export function splitNet(netCents: number, cut: PlatformCut): { creatorCents: number; coopCents: number } {
  assertCents("net", netCents);
  assertCut(cut);
  const creatorCents = floorShare(netCents, cut.streamerShare);
  return { creatorCents, coopCents: netCents - creatorCents };
}

interface Split {
  taxCents: number;
  creatorCents: number;
  coopCents: number;
}

/** The split of the first `cumulativeCents` of a payment's gross, on the original's rounding rules. */
function splitAt(cumulativeCents: number, grossCents: number, taxCents: number, cut: PlatformCut): Split {
  const tax = mulDivFloor(taxCents, BigInt(cumulativeCents), BigInt(grossCents));
  return { taxCents: tax, ...splitNet(cumulativeCents - tax, cut) };
}

/**
 * The tax / creator / co-op portions of reversing `amountCents` of a payment when
 * `alreadyReversedCents` has been reversed before. Computed as split(cumulative) −
 * split(already), so partial reversals add up to exactly the original split: a full reversal,
 * however it is sliced, returns precisely the original tax, creator share and cut.
 * Every portion is non-negative (each split component is monotone in the amount).
 */
export function reversalSplit(
  original: { grossCents: number; taxCents: number },
  cut: PlatformCut,
  alreadyReversedCents: number,
  amountCents: number,
): Split {
  assertCents("gross", original.grossCents, { allowZero: false });
  assertCents("tax", original.taxCents);
  assertCents("alreadyReversed", alreadyReversedCents);
  assertCents("amount", amountCents, { allowZero: false });
  if (original.taxCents > original.grossCents) throw new RangeError("tax cannot exceed gross");
  if (alreadyReversedCents + amountCents > original.grossCents) {
    throw new RangeError("cannot reverse more than the payment's gross amount");
  }
  const before = splitAt(alreadyReversedCents, original.grossCents, original.taxCents, cut);
  const after = splitAt(alreadyReversedCents + amountCents, original.grossCents, original.taxCents, cut);
  return {
    taxCents: after.taxCents - before.taxCents,
    creatorCents: after.creatorCents - before.creatorCents,
    coopCents: after.coopCents - before.coopCents,
  };
}

function settlementAccount(provider: string, settlement: Settlement): string {
  return settlement === "cash" ? accounts.cash(provider) : accounts.providerReceivable(provider);
}

function finish(p: Omit<Posting, "entries"> & { entries: PostingEntry[] }): Posting {
  const posting = { ...p, entries: nonZero(p.entries) };
  validatePosting(posting);
  return posting;
}

// Payments ---------------------------------------------------------------------------------

export interface PaymentSucceededInput {
  paymentId: string;
  paymentKind: "subscription" | "tip";
  provider: string;
  /** `receivable` for provider-collected funds not yet settled (e.g. manual adapter). */
  settlement?: Settlement;
  creatorUserId: string;
  /** Gross charged to the payer, including tax. */
  grossCents: number;
  taxCents: number;
  /** Processor fee, borne by the co-op as an expense. */
  feeCents: number;
  currency: string;
  /** The `platform.cut` in effect; recorded in metadata so reversals can reuse it. */
  cut: PlatformCut;
  occurredAt: Date;
}

/**
 * A subscription or tip payment: the payer's money arrives (cash or provider receivable), tax
 * becomes payable, and the net is split between the creator's hold and the co-op's revenue.
 * The metadata is everything `postReversal` needs to reverse it later.
 */
export function paymentSucceeded(i: PaymentSucceededInput): Posting {
  assertCents("gross", i.grossCents, { allowZero: false });
  assertCents("tax", i.taxCents);
  assertCents("fee", i.feeCents);
  if (i.taxCents > i.grossCents) throw new RangeError("tax cannot exceed gross");
  const settlement = i.settlement ?? "cash";
  const settle = settlementAccount(i.provider, settlement);
  const { creatorCents, coopCents } = splitNet(i.grossCents - i.taxCents, i.cut);
  return finish({
    kind: "payment",
    description: i.paymentKind === "subscription" ? "Subscription payment" : "Tip payment",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `payment:${i.paymentId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: {
      paymentKind: i.paymentKind,
      creatorUserId: i.creatorUserId,
      provider: i.provider,
      settlement,
      revenueGrossCents: i.grossCents,
      taxCents: i.taxCents,
      creatorCents,
      coopCents,
      feeCents: i.feeCents,
      streamerShare: i.cut.streamerShare,
      coopShare: i.cut.coopShare,
    },
    entries: [
      { code: settle, amountCents: i.grossCents, memo: "gross received" },
      { code: accounts.taxPayable(), amountCents: -i.taxCents, memo: "tax collected" },
      { code: accounts.creatorHold(i.creatorUserId), amountCents: -creatorCents, memo: holdMemo(i.paymentId) },
      { code: accounts.platformCut(), amountCents: -coopCents, memo: "co-op share" },
      { code: accounts.paymentFees(), amountCents: i.feeCents, memo: "processor fee" },
      { code: settle, amountCents: -i.feeCents, memo: "processor fee" },
    ],
  });
}

/** When a payment's creator share leaves the chargeback hold window. */
export function holdReleaseDueAt(succeededAt: Date, holdDays: number): Date {
  if (!Number.isFinite(holdDays) || holdDays < 0) throw new RangeError("holdDays must be non-negative");
  return new Date(succeededAt.getTime() + holdDays * 86_400_000);
}

export interface HoldReleaseInput {
  paymentId: string;
  creatorUserId: string;
  /** What is still attributable to this payment's hold lot. */
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

/** Creator share moves from the hold to the payable liability once the hold period ends. */
export function holdRelease(i: HoldReleaseInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "hold_release",
    description: "Hold period ended",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `hold-release:${i.paymentId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { creatorUserId: i.creatorUserId },
    entries: [
      { code: accounts.creatorHold(i.creatorUserId), amountCents: i.amountCents, memo: holdMemo(i.paymentId) },
      { code: accounts.creator(i.creatorUserId), amountCents: -i.amountCents, memo: "released from hold" },
    ],
  });
}

// Refunds and chargebacks -------------------------------------------------------------------

/** What remains on hold for one payment. */
export interface HoldLot {
  paymentId: string;
  cents: number;
}

/** Creator balances in natural terms (positive = owed to the creator). */
export interface CreatorBalances {
  /** `liability:creator` (released, unpaid, not reserved for a payout). */
  liabilityCents: number;
  /** Remaining hold per payment, oldest payment first. */
  holdLots: readonly HoldLot[];
}

export interface PaymentReversalInput {
  /** The dispute row (kind refund or chargeback); keys the posting. */
  disputeId: string;
  paymentId: string;
  /** The original payment's ledger transaction, if known. */
  originalTransactionId?: string;
  provider: string;
  /** The account the money leaves from (default cash). */
  settlement?: Settlement;
  creatorUserId: string;
  currency: string;
  occurredAt: Date;
  original: { grossCents: number; taxCents: number };
  /** The cut used for the original payment (from its metadata), not today's setting. */
  cut: PlatformCut;
  /** Net amount already reversed (refunds + chargebacks − won chargebacks). */
  alreadyReversedCents: number;
  amountCents: number;
  balances: CreatorBalances;
}

interface Source {
  code: string;
  memo: string;
  available: number;
}

/** Take `amount` from sources in order; the shortfall becomes a receivable from the creator. */
function drawFrom(amount: number, sources: Source[], shortfallCode: string): PostingEntry[] {
  const entries: PostingEntry[] = [];
  let left = amount;
  for (const s of sources) {
    const used = Math.min(left, Math.max(0, s.available));
    if (used > 0) {
      entries.push({ code: s.code, amountCents: used, memo: s.memo });
      left -= used;
    }
  }
  if (left > 0) entries.push({ code: shortfallCode, amountCents: left, memo: "clawback shortfall" });
  return entries;
}

/** The reversed payment's own hold lot, and the other lots oldest first. */
function holdSources(i: PaymentReversalInput): { own: Source[]; others: Source[] } {
  const code = accounts.creatorHold(i.creatorUserId);
  const toSource = (l: HoldLot): Source => ({ code, memo: holdMemo(l.paymentId), available: l.cents });
  return {
    own: i.balances.holdLots.filter((l) => l.paymentId === i.paymentId).map(toSource),
    others: i.balances.holdLots.filter((l) => l.paymentId !== i.paymentId).map(toSource),
  };
}

function liabilitySource(i: PaymentReversalInput): Source {
  return {
    code: accounts.creator(i.creatorUserId),
    memo: "creator share reversed",
    available: i.balances.liabilityCents,
  };
}

function reversal(
  i: PaymentReversalInput,
  kind: "refund" | "chargeback",
  sources: Source[],
  extra: PostingEntry[],
  extraMeta: Posting["metadata"],
): Posting {
  assertCurrency(i.currency);
  const split = reversalSplit(i.original, i.cut, i.alreadyReversedCents, i.amountCents);
  const settlement = i.settlement ?? "cash";
  const settle = settlementAccount(i.provider, settlement);
  const receivable = accounts.creatorReceivable(i.creatorUserId);
  const creatorEntries = drawFrom(split.creatorCents, sources, receivable);
  const receivableCents = creatorEntries.filter((e) => e.code === receivable).reduce((s, e) => s + e.amountCents, 0);
  return finish({
    kind,
    description: kind === "refund" ? "Payment refunded" : "Payment charged back",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `${kind}:${i.disputeId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    reversesId: i.originalTransactionId ?? null,
    metadata: {
      disputeId: i.disputeId,
      creatorUserId: i.creatorUserId,
      provider: i.provider,
      settlement,
      revenueGrossCents: -i.amountCents,
      taxCents: negate(split.taxCents),
      creatorCents: negate(split.creatorCents),
      coopCents: negate(split.coopCents),
      receivableCents,
      ...extraMeta,
    },
    entries: [
      { code: settle, amountCents: -i.amountCents, memo: `${kind} paid out` },
      { code: accounts.taxPayable(), amountCents: split.taxCents, memo: "tax reversed" },
      ...creatorEntries,
      { code: accounts.platformCut(), amountCents: split.coopCents, memo: "co-op share reversed" },
      ...extra,
    ],
  });
}

/**
 * Full or partial refund. Reverses tax, creator share and cut proportionally; the creator
 * share comes first from this payment's own hold lot, then released earnings, then other hold
 * lots oldest first, and any shortfall becomes a receivable from the creator.
 * Use `postReversal`, which reads these inputs from the ledger under locks.
 */
export function refund(i: PaymentReversalInput): Posting {
  const { own, others } = holdSources(i);
  return reversal(i, "refund", [...own, liabilitySource(i), ...others], [], {});
}

/**
 * Chargeback with clawback: reversed like a refund, but the creator share is taken from
 * released earnings first, then hold lots (own first, then oldest), then booked as a
 * receivable. Dispute fees are an expense paid from the same settlement account.
 */
export function chargeback(i: PaymentReversalInput & { disputeFeeCents: number }): Posting {
  assertCents("disputeFee", i.disputeFeeCents);
  const settle = settlementAccount(i.provider, i.settlement ?? "cash");
  const { own, others } = holdSources(i);
  return reversal(
    i,
    "chargeback",
    [liabilitySource(i), ...own, ...others],
    [
      { code: accounts.paymentFees(), amountCents: i.disputeFeeCents, memo: "dispute fee" },
      { code: settle, amountCents: -i.disputeFeeCents, memo: "dispute fee" },
    ],
    { disputeFeeCents: i.disputeFeeCents },
  );
}

export interface ChargebackReversalInput {
  /** The dispute the chargeback was posted for. */
  disputeId: string;
  paymentId: string;
  creatorUserId: string;
  provider: string;
  settlement?: Settlement;
  currency: string;
  occurredAt: Date;
  /** The original chargeback's amounts (positive), from its metadata. */
  chargeback: { amountCents: number; taxCents: number; creatorCents: number; coopCents: number };
  /** The creator's current clawback receivable (natural). */
  receivableCents: number;
  /** Dispute fee returned by the provider, if any. */
  feeRefundCents?: number;
  chargebackTransactionId?: string;
}

/**
 * A chargeback the co-op won: the money comes back, tax and cut are restored, and the creator
 * share first cancels what the creator still owes, then is credited as released earnings (a
 * decided dispute carries no further hold risk, and hold lots are never re-opened).
 */
export function chargebackReversal(i: ChargebackReversalInput): Posting {
  const c = i.chargeback;
  assertCents("amount", c.amountCents, { allowZero: false });
  for (const [k, v] of Object.entries({ tax: c.taxCents, creator: c.creatorCents, coop: c.coopCents }))
    assertCents(k, v);
  if (c.taxCents + c.creatorCents + c.coopCents !== c.amountCents) {
    throw new RangeError("chargeback components must sum to its amount");
  }
  const fee = i.feeRefundCents ?? 0;
  assertCents("feeRefund", fee);
  const settlement = i.settlement ?? "cash";
  const settle = settlementAccount(i.provider, settlement);
  const cancel = Math.max(0, Math.min(c.creatorCents, i.receivableCents));
  return finish({
    kind: "chargeback_reversal",
    description: "Chargeback won",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `chargeback-reversal:${i.disputeId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    reversesId: i.chargebackTransactionId ?? null,
    metadata: {
      disputeId: i.disputeId,
      creatorUserId: i.creatorUserId,
      provider: i.provider,
      settlement,
      revenueGrossCents: c.amountCents,
      taxCents: c.taxCents,
      creatorCents: c.creatorCents,
      coopCents: c.coopCents,
      feeRefundCents: fee,
    },
    entries: [
      { code: settle, amountCents: c.amountCents, memo: "chargeback reversed" },
      { code: accounts.taxPayable(), amountCents: -c.taxCents, memo: "tax restored" },
      { code: accounts.creatorReceivable(i.creatorUserId), amountCents: -cancel, memo: "clawback cancelled" },
      {
        code: accounts.creator(i.creatorUserId),
        amountCents: -(c.creatorCents - cancel),
        memo: "creator share restored",
      },
      { code: accounts.platformCut(), amountCents: -c.coopCents, memo: "co-op share restored" },
      { code: settle, amountCents: fee, memo: "dispute fee returned" },
      { code: accounts.paymentFees(), amountCents: -fee, memo: "dispute fee returned" },
    ],
  });
}

// Payouts -----------------------------------------------------------------------------------
//
// A payout moves in two steps so money promised to a creator can never be clawed back from
// under it: the batch *reserves* it (creator liability → payout clearing), and sending it
// moves clearing → cash. A chargeback after the batch therefore cannot touch reserved money
// (it books a receivable instead), and a failed payout *cancels* the reservation.

/** What a creator can be paid now: released earnings net of what they owe the co-op. */
export function availableToPay(b: { liabilityCents: number; receivableCents: number }): number {
  return b.liabilityCents - b.receivableCents;
}

export interface PayoutReserveInput {
  payoutId: string;
  userId: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  /** Natural balances: released earnings and any clawback receivable. */
  balances: { liabilityCents: number; receivableCents: number };
  /** `payout.rules.minimumCents`. */
  minimumCents: number;
  /** Closing an account pays out whatever is left, even below the minimum. */
  closingAccount?: boolean;
}

/**
 * Reserve a payout. Any clawback receivable is netted against earnings in the same
 * transaction, so after reserving everything available both accounts are settled.
 */
export function payoutReserve(i: PayoutReserveInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  assertCents("minimum", i.minimumCents);
  const available = availableToPay(i.balances);
  if (i.amountCents > available) {
    throw new InsufficientBalanceError(`payout of ${i.amountCents} exceeds the available ${available} cents`);
  }
  if (i.amountCents < i.minimumCents && !i.closingAccount) {
    throw new PayoutBelowMinimumError(`payout of ${i.amountCents} is below the minimum of ${i.minimumCents} cents`);
  }
  const offset = Math.max(0, Math.min(i.balances.receivableCents, i.balances.liabilityCents));
  return finish({
    kind: "payout_reserve",
    description: i.closingAccount ? "Final payout reserved (account closed)" : "Payout reserved",
    refType: "payout",
    refId: i.payoutId,
    idempotencyKey: `payout-reserve:${i.payoutId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId, amountCents: i.amountCents, receivableNettedCents: offset },
    entries: [
      { code: accounts.creator(i.userId), amountCents: i.amountCents + offset, memo: "reserved for payout" },
      { code: accounts.creatorReceivable(i.userId), amountCents: -offset, memo: "clawback netted" },
      { code: accounts.payoutClearing(i.userId), amountCents: -i.amountCents, memo: "reserved for payout" },
    ],
  });
}

export interface PayoutSentInput {
  payoutId: string;
  userId: string;
  provider: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

/** The reserved money was sent. Never refused for balance reasons: the money has left. */
export function payoutSent(i: PayoutSentInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "payout",
    description: "Creator payout",
    refType: "payout",
    refId: i.payoutId,
    idempotencyKey: `payout:${i.payoutId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId },
    entries: [
      { code: accounts.payoutClearing(i.userId), amountCents: i.amountCents, memo: "paid out" },
      { code: accounts.cash(i.provider), amountCents: -i.amountCents, memo: "paid out" },
    ],
  });
}

export interface PayoutCancelInput {
  payoutId: string;
  userId: string;
  amountCents: number;
  /** The receivable netted when the payout was reserved (restored as owed again). */
  receivableNettedCents: number;
  currency: string;
  occurredAt: Date;
}

/** A payout failed or was cancelled before money left: undo the reservation exactly. */
export function payoutCancel(i: PayoutCancelInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  assertCents("receivableNetted", i.receivableNettedCents);
  return finish({
    kind: "payout_cancel",
    description: "Payout cancelled",
    refType: "payout",
    refId: i.payoutId,
    idempotencyKey: `payout-cancel:${i.payoutId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId },
    entries: [
      { code: accounts.payoutClearing(i.userId), amountCents: i.amountCents, memo: "reservation cancelled" },
      { code: accounts.creatorReceivable(i.userId), amountCents: i.receivableNettedCents, memo: "clawback restored" },
      {
        code: accounts.creator(i.userId),
        amountCents: -(i.amountCents + i.receivableNettedCents),
        memo: "reservation cancelled",
      },
    ],
  });
}

// Period close ------------------------------------------------------------------------------

export interface PeriodCloseInput {
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  occurredAt: Date;
  /** Raw (signed) period activity of each revenue and expense account. */
  balances: readonly { code: string; rawCents: number }[];
}

/**
 * Close a period's revenue and expense accounts into retained surplus, so the surplus the
 * co-op may allocate as patronage actually sits in equity. A loss closes as a debit.
 */
export function periodClose(i: PeriodCloseInput): Posting {
  if (!(i.periodStart < i.periodEnd)) throw new RangeError("periodStart must be before periodEnd");
  const entries: PostingEntry[] = [];
  let net = 0;
  for (const b of i.balances) {
    const type = describeAccount(b.code).type;
    if (type !== "revenue" && type !== "expense") throw new RangeError(`${b.code} is not a revenue or expense account`);
    if (!Number.isSafeInteger(b.rawCents)) throw new RangeError("balances must be integer cents");
    entries.push({ code: b.code, amountCents: negate(b.rawCents), memo: "period close" });
    net += b.rawCents;
  }
  entries.push({ code: accounts.retainedSurplus(), amountCents: net, memo: "period result" });
  return finish({
    kind: "period_close",
    description: "Period closed to retained surplus",
    refType: null,
    refId: null,
    idempotencyKey: `period-close:${i.currency}:${i.periodStart.toISOString()}:${i.periodEnd.toISOString()}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: {
      currency: i.currency,
      periodStart: i.periodStart.toISOString(),
      periodEnd: i.periodEnd.toISOString(),
      surplusCents: negate(net),
    },
    entries,
  });
}
// Membership shares -------------------------------------------------------------------------

export interface ShareInput {
  shareId: string;
  userId: string;
  provider: string;
  settlement?: Settlement;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

/** A viewer buys a refundable member share: cash in, a liability to the member. */
export function sharePurchase(i: ShareInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "share_purchase",
    description: "Member share purchased",
    refType: "membership_share",
    refId: i.shareId,
    idempotencyKey: `share-purchase:${i.shareId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId },
    entries: [
      { code: settlementAccount(i.provider, i.settlement ?? "cash"), amountCents: i.amountCents },
      { code: accounts.memberShare(i.userId), amountCents: -i.amountCents },
    ],
  });
}

/** The share is returned when the member exits. */
export function shareRefund(i: ShareInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "share_refund",
    description: "Member share refunded on exit",
    refType: "membership_share",
    refId: i.shareId,
    idempotencyKey: `share-refund:${i.shareId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId },
    entries: [
      { code: accounts.memberShare(i.userId), amountCents: i.amountCents },
      { code: settlementAccount(i.provider, i.settlement ?? "cash"), amountCents: -i.amountCents },
    ],
  });
}

// Costs, patronage, manual adapter -----------------------------------------------------------

export interface InfrastructureCostInput {
  infraCostId: string;
  /** Slug, e.g. `hosting`, `bandwidth`, `storage`. */
  category: string;
  provider: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

export function infrastructureCost(i: InfrastructureCostInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "infrastructure_cost",
    description: "Infrastructure cost",
    refType: "infra_cost",
    refId: i.infraCostId,
    idempotencyKey: `infra-cost:${i.infraCostId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { category: i.category },
    entries: [
      { code: accounts.infrastructure(i.category), amountCents: i.amountCents },
      { code: accounts.cash(i.provider), amountCents: -i.amountCents },
    ],
  });
}

export interface PatronageAllocationInput {
  periodId: string;
  currency: string;
  occurredAt: Date;
  allocations: readonly { userId: string; amountCents: number }[];
}

/** Approved patronage: retained surplus becomes a payable to each member. */
export function patronageAllocation(i: PatronageAllocationInput): Posting {
  let total = 0;
  const credits: PostingEntry[] = [];
  for (const a of i.allocations) {
    assertCents("allocation", a.amountCents);
    total += a.amountCents;
    credits.push({ code: accounts.patronagePayable(a.userId), amountCents: -a.amountCents });
  }
  if (total === 0) throw new RangeError("a patronage allocation must distribute a positive amount");
  return finish({
    kind: "patronage_allocation",
    description: "Patronage allocated",
    refType: "patronage_period",
    refId: i.periodId,
    idempotencyKey: `patronage-allocation:${i.periodId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { totalCents: total },
    entries: [{ code: accounts.retainedSurplus(), amountCents: total }, ...credits],
  });
}

export interface PatronagePayoutInput {
  periodId: string;
  userId: string;
  provider: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

export function patronagePayout(i: PatronagePayoutInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "patronage_payout",
    description: "Patronage paid",
    refType: "patronage_period",
    refId: i.periodId,
    idempotencyKey: `patronage-payout:${i.periodId}:${i.userId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId },
    entries: [
      { code: accounts.patronagePayable(i.userId), amountCents: i.amountCents },
      { code: accounts.cash(i.provider), amountCents: -i.amountCents },
    ],
  });
}

export interface ManualConfirmationInput {
  paymentId: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  /** Defaults to the manual adapter. */
  provider?: string;
}

/** The treasurer confirms an offline payment arrived: the receivable becomes cash. */
export function manualConfirmation(i: ManualConfirmationInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  const provider = i.provider ?? "manual";
  return finish({
    kind: "manual_confirmation",
    description: "Offline payment received",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `manual-confirmation:${i.paymentId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: {},
    entries: [
      { code: accounts.cash(provider), amountCents: i.amountCents },
      { code: accounts.providerReceivable(provider), amountCents: -i.amountCents },
    ],
  });
}
