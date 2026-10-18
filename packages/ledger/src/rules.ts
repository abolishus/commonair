// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Posting rules: pure functions from a business event to a balanced `Posting`.
 * Sign convention: debits positive, credits negative. Every rule validates its result, so a
 * rule can never hand the poster an unbalanced set.
 */
import { accounts, assertCurrency } from "./accounts.ts";
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
 */
export function paymentSucceeded(i: PaymentSucceededInput): Posting {
  assertCents("gross", i.grossCents, { allowZero: false });
  assertCents("tax", i.taxCents);
  assertCents("fee", i.feeCents);
  if (i.taxCents > i.grossCents) throw new RangeError("tax cannot exceed gross");
  const settle = settlementAccount(i.provider, i.settlement ?? "cash");
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
      { code: accounts.creatorHold(i.creatorUserId), amountCents: -creatorCents, memo: "creator share (on hold)" },
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

/**
 * How much of a payment's hold to release: what remains of that payment's hold, but never
 * more than the creator's total hold balance (a chargeback may already have drawn on it).
 */
export function holdReleaseAmount(paymentHoldCents: number, creatorHoldCents: number): number {
  return Math.max(0, Math.min(paymentHoldCents, creatorHoldCents));
}

export interface HoldReleaseInput {
  paymentId: string;
  creatorUserId: string;
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
      { code: accounts.creatorHold(i.creatorUserId), amountCents: i.amountCents },
      { code: accounts.creator(i.creatorUserId), amountCents: -i.amountCents },
    ],
  });
}

// Refunds and chargebacks -------------------------------------------------------------------

/** Creator balances in natural terms (positive = owed to the creator). */
export interface CreatorBalances {
  /** `liability:creator` (released, unpaid). */
  liabilityCents: number;
  /** `liability:creator-hold` (all payments still in their hold window). */
  holdCents: number;
  /** What remains on hold for this payment specifically. */
  paymentHoldCents: number;
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
  /** Refunds and chargebacks already posted against this payment. */
  alreadyReversedCents: number;
  amountCents: number;
  balances: CreatorBalances;
}

interface Source {
  code: string;
  available: number;
}

/** Take `amount` from sources in order; the shortfall becomes a receivable from the creator. */
function drawFrom(amount: number, sources: Source[], shortfallCode: string): PostingEntry[] {
  const taken = new Map<string, number>();
  let left = amount;
  for (const s of sources) {
    const used = Math.min(left, Math.max(0, s.available - (taken.get(s.code) ?? 0)));
    if (used > 0) {
      taken.set(s.code, (taken.get(s.code) ?? 0) + used);
      left -= used;
    }
  }
  const entries: PostingEntry[] = [...taken].map(([code, cents]) => ({ code, amountCents: cents }));
  if (left > 0) entries.push({ code: shortfallCode, amountCents: left, memo: "clawback shortfall" });
  return entries;
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
  const settle = settlementAccount(i.provider, i.settlement ?? "cash");
  const creatorEntries = drawFrom(split.creatorCents, sources, accounts.creatorReceivable(i.creatorUserId));
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
      revenueGrossCents: -i.amountCents,
      taxCents: negate(split.taxCents),
      creatorCents: negate(split.creatorCents),
      coopCents: negate(split.coopCents),
      ...extraMeta,
    },
    entries: [
      { code: settle, amountCents: -i.amountCents, memo: `${kind} paid out` },
      { code: accounts.taxPayable(), amountCents: split.taxCents, memo: "tax reversed" },
      ...creatorEntries.map((e) => ({ memo: "creator share reversed", ...e })),
      { code: accounts.platformCut(), amountCents: split.coopCents, memo: "co-op share reversed" },
      ...extra,
    ],
  });
}

/**
 * Full or partial refund. Reverses tax, creator share and cut proportionally; the creator
 * share comes first from this payment's own remaining hold, then released earnings, then any
 * other hold, and any shortfall becomes a receivable from the creator.
 */
export function refund(i: PaymentReversalInput): Posting {
  const b = i.balances;
  return reversal(
    i,
    "refund",
    [
      { code: accounts.creatorHold(i.creatorUserId), available: Math.min(b.paymentHoldCents, b.holdCents) },
      { code: accounts.creator(i.creatorUserId), available: b.liabilityCents },
      { code: accounts.creatorHold(i.creatorUserId), available: b.holdCents },
    ],
    [],
    {},
  );
}

/**
 * Chargeback with clawback: reversed like a refund, but the creator share is taken from
 * released earnings first, then the hold, then booked as a receivable. Dispute fees are an
 * expense paid from the same settlement account.
 */
export function chargeback(i: PaymentReversalInput & { disputeFeeCents: number }): Posting {
  assertCents("disputeFee", i.disputeFeeCents);
  const b = i.balances;
  const settle = settlementAccount(i.provider, i.settlement ?? "cash");
  return reversal(
    i,
    "chargeback",
    [
      { code: accounts.creator(i.creatorUserId), available: b.liabilityCents },
      { code: accounts.creatorHold(i.creatorUserId), available: b.holdCents },
    ],
    [
      { code: accounts.paymentFees(), amountCents: i.disputeFeeCents, memo: "dispute fee" },
      { code: settle, amountCents: -i.disputeFeeCents, memo: "dispute fee" },
    ],
    { disputeFeeCents: i.disputeFeeCents },
  );
}

// Payouts -----------------------------------------------------------------------------------

export interface PayoutInput {
  payoutId: string;
  userId: string;
  provider: string;
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

/** What a creator can be paid now: released earnings net of what they owe the co-op. */
export function availableToPay(b: { liabilityCents: number; receivableCents: number }): number {
  return b.liabilityCents - b.receivableCents;
}

/**
 * Pay a creator. Any clawback receivable is netted against their earnings in the same
 * transaction, so after a payout of everything available both accounts are settled.
 */
export function payout(i: PayoutInput): Posting {
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
    kind: "payout",
    description: i.closingAccount ? "Final payout (account closed)" : "Creator payout",
    refType: "payout",
    refId: i.payoutId,
    idempotencyKey: `payout:${i.payoutId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { userId: i.userId, receivableNettedCents: offset },
    entries: [
      { code: accounts.creator(i.userId), amountCents: i.amountCents + offset, memo: "paid out" },
      { code: accounts.creatorReceivable(i.userId), amountCents: -offset, memo: "clawback netted" },
      { code: accounts.cash(i.provider), amountCents: -i.amountCents, memo: "paid out" },
    ],
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
