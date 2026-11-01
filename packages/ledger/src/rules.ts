// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Posting rules: pure functions from a business event to a balanced `Posting`.
 * Sign convention: debits positive, credits negative. Every rule validates its result, so a
 * rule can never hand the poster an unbalanced set.
 *
 * Hold lots: every entry on a `liability:creator-hold` account carries the memo
 * `hold:<paymentId>:<recipientUserId>`, so the hold is tracked per payment and per recipient
 * ("lot", ADR 0013 decision 1) and a release can only ever release what is still attributable to
 * that recipient's slice of that payment. A single-creator payment is the one-recipient case.
 */
import { accounts, assertCurrency, describeAccount } from "./accounts.ts";
import {
  apportionCumulative,
  assertCents,
  compareUserIds,
  floorShare,
  mulDivFloor,
  negate,
  splitNetN,
} from "./math.ts";
import { PaymentMetaV2, ReversalMetaV2 } from "./meta.ts";
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

/** The memo that attributes a hold entry to one recipient's lot of one payment (decision (i)). */
export const holdMemo = (paymentId: string, userId: string) => `hold:${paymentId}:${userId.toLowerCase()}`;

/** The (payment, recipient) a hold memo names, or null for anything else. */
export function parseHoldMemo(memo: string): { paymentId: string; userId: string } | null {
  const m = /^hold:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(memo);
  return m?.[1] && m[2] ? { paymentId: m[1], userId: m[2] } : null;
}

/** The memo on a `liability:split-suspense` entry: which owner's channel the withheld share came from. */
export const suspenseMemo = (ownerUserId: string) => `owner:${ownerUserId.toLowerCase()}`;

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
export function splitAt(cumulativeCents: number, grossCents: number, taxCents: number, cut: PlatformCut): Split {
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
  /** `governance_settings_history.id` of that cut (`loadMoneySettings`); null = the founding seed. */
  cutHistoryId: string | null;
  occurredAt: Date;
  /** The split version active for this payment's kind at `occurredAt`; absent or null: the owner alone. */
  split?: PaymentSplit | null;
}

/** The split version a payment is posted under (ADR 0013 decision 3): its id and its crew. */
export interface PaymentSplit {
  versionId: string;
  crew: readonly { userId: string; bps: number }[];
}

/**
 * A subscription or tip payment: the payer's money arrives (cash or provider receivable), tax
 * becomes payable, the co-op cut is taken once, and the creator share is divided between the
 * owner and any crew (`splitNetN`), each into their own hold lot. The metadata is everything
 * `postReversal` needs to reverse it later, the share vector included.
 */
export function paymentSucceeded(i: PaymentSucceededInput): Posting {
  assertCents("gross", i.grossCents, { allowZero: false });
  assertCents("tax", i.taxCents);
  assertCents("fee", i.feeCents);
  if (i.taxCents > i.grossCents) throw new RangeError("tax cannot exceed gross");
  const settlement = i.settlement ?? "cash";
  const settle = settlementAccount(i.provider, settlement);
  const { creatorCents, coopCents } = splitNet(i.grossCents - i.taxCents, i.cut);
  const shares = splitNetN(creatorCents, i.creatorUserId, i.split?.crew ?? []);
  return finish({
    kind: "payment",
    description: i.paymentKind === "subscription" ? "Subscription payment" : "Tip payment",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `payment:${i.paymentId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: PaymentMetaV2.parse({
      v: 2,
      paymentKind: i.paymentKind,
      creatorUserId: i.creatorUserId.toLowerCase(),
      provider: i.provider,
      settlement,
      revenueGrossCents: i.grossCents,
      taxCents: i.taxCents,
      creatorCents,
      coopCents,
      feeCents: i.feeCents,
      streamerShare: i.cut.streamerShare,
      coopShare: i.cut.coopShare,
      cutHistoryId: i.cutHistoryId,
      splitVersionId: i.split ? i.split.versionId : null,
      shares,
    } satisfies PaymentMetaV2),
    entries: [
      { code: settle, amountCents: i.grossCents, memo: "gross received" },
      { code: accounts.taxPayable(), amountCents: -i.taxCents, memo: "tax collected" },
      ...shares.map((s) => ({
        code: accounts.creatorHold(s.userId),
        amountCents: -s.creatorCents,
        memo: holdMemo(i.paymentId, s.userId),
      })),
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
  /** The recipient whose lot is released: the owner, or a crew member. */
  creatorUserId: string;
  /** The payment's owner; defaults to the recipient (a single-creator payment). */
  ownerUserId?: string;
  /** What is still attributable to this recipient's lot of the payment. */
  amountCents: number;
  currency: string;
  occurredAt: Date;
  /**
   * A crew recipient who is suspended, terminated or under a legal hold (ADR 0013 decision 7): the
   * lot moves to `liability:split-suspense:<recipient>` instead of their released earnings.
   */
  withheld?: boolean;
}

/** The idempotency key of one recipient's release of one payment's lot. */
export const holdReleaseKey = (paymentId: string, userId: string) =>
  `hold-release:${paymentId}:${userId.toLowerCase()}`;

/**
 * One recipient's share moves from the hold to the payable liability once the hold period ends,
 * or into split suspense when the recipient is withheld. Keyed per recipient, so one recipient's
 * release (or ban) never blocks or releases another's lot (ADR 0013 decision 1).
 */
export function holdRelease(i: HoldReleaseInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  const recipient = i.creatorUserId.toLowerCase();
  const owner = (i.ownerUserId ?? i.creatorUserId).toLowerCase();
  const role = recipient === owner ? "owner" : "crew";
  if (i.withheld && role === "owner") throw new RangeError("only a crew share is withheld into split suspense");
  return finish({
    kind: "hold_release",
    description: i.withheld ? "Hold period ended; share withheld" : "Hold period ended",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: holdReleaseKey(i.paymentId, recipient),
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: {
      creatorUserId: recipient,
      recipientUserId: recipient,
      ownerUserId: owner,
      role,
      withheld: !!i.withheld,
    },
    entries: [
      { code: accounts.creatorHold(recipient), amountCents: i.amountCents, memo: holdMemo(i.paymentId, recipient) },
      i.withheld
        ? { code: accounts.splitSuspense(recipient), amountCents: -i.amountCents, memo: suspenseMemo(owner) }
        : { code: accounts.creator(recipient), amountCents: -i.amountCents, memo: "released from hold" },
    ],
  });
}

// Refunds and chargebacks -------------------------------------------------------------------

/** What remains on hold for one payment in one recipient's hold account. */
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

/** One recipient's recorded slice of the payment (`PaymentMetaV2.shares`). */
export interface RecipientShare {
  userId: string;
  role: "owner" | "crew";
  creatorCents: number;
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
  /** The channel owner, who covers every shortfall (ADR 0013 decision 5). */
  creatorUserId: string;
  currency: string;
  occurredAt: Date;
  original: { grossCents: number; taxCents: number };
  /** The cut used for the original payment (from its metadata), not today's setting. */
  cut: PlatformCut;
  /** Net amount already reversed (refunds + chargebacks − won chargebacks). */
  alreadyReversedCents: number;
  amountCents: number;
  /** The owner's balances: released earnings and every hold lot. */
  balances: CreatorBalances;
  /** The payment's recorded share vector; absent: the owner alone. */
  shares?: readonly RecipientShare[];
  /** What is still held in each crew recipient's own lot of this payment (by user id). */
  crewLots?: Readonly<Record<string, number>>;
  /**
   * Each recipient's net creator cents already reversed (refunds + chargebacks − won), by user id,
   * from earlier reversals' recorded slices. Needed once a chargeback was won (`reversalSlices`).
   */
  reversedByRecipient?: Readonly<Record<string, number>>;
}

interface Source {
  code: string;
  memo: string;
  available: number;
}

/** Take up to `amount` from sources in order (mutating what they have left); returns the shortfall. */
function drawFrom(amount: number, sources: Source[], into: PostingEntry[]): number {
  let left = amount;
  for (const s of sources) {
    const used = Math.min(left, Math.max(0, s.available));
    if (used > 0) {
      into.push({ code: s.code, amountCents: used, memo: s.memo });
      s.available -= used;
      left -= used;
    }
  }
  return left;
}

/** Entries on the same account with the same memo, summed (and zeros dropped). */
function merged(entries: readonly PostingEntry[]): PostingEntry[] {
  const out: PostingEntry[] = [];
  const at = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.code}\u0000${e.memo ?? ""}`;
    const idx = at.get(k);
    const prev = idx === undefined ? undefined : out[idx];
    if (prev) prev.amountCents += e.amountCents;
    else {
      at.set(k, out.length);
      out.push({ ...e });
    }
  }
  return out.filter((e) => e.amountCents !== 0);
}

/**
 * Each recipient's slice of a reversal's creator portion: the difference of two cumulative
 * apportionments over the recorded `creatorCents` vector (ADR 0013 decision 3), so any sequence
 * of partial reversals returns exactly each recipient's share and no slice is ever negative.
 *
 * A won chargeback gives back its own slices, not the end of that sequence, so after one the
 * per-recipient net (`reversed`, aligned with `shares`) no longer matches the cumulative
 * position. Then the slice is apportioned over what each recipient still has unreversed, so no
 * recipient is reversed beyond its share; a cent the remainders cannot hold (the creator total
 * is itself apportioned from the net gross) falls to the owner (`ownerIndex`), who covers anyway.
 */
export function reversalSlices(
  shares: readonly RecipientShare[],
  creatorBeforeCents: number,
  creatorCents: number,
  opts: { reversed?: readonly number[]; ownerIndex?: number } = {},
): number[] {
  const weights = shares.map((s) => s.creatorCents);
  const before = apportionCumulative(Math.min(creatorBeforeCents, sumOf(weights)), weights);
  const net = opts.reversed;
  if (!net || before.every((b, k) => b === (net[k] ?? 0))) {
    const after = apportionCumulative(creatorBeforeCents + creatorCents, weights);
    return after.map((a, k) => a - (before[k] ?? 0));
  }
  const remaining = weights.map((w, k) => Math.max(0, w - Math.max(0, net[k] ?? 0)));
  const room = sumOf(remaining);
  const slices = apportionCumulative(Math.min(creatorCents, room), remaining);
  const excess = creatorCents - Math.min(creatorCents, room);
  if (excess > 0) {
    if (opts.ownerIndex === undefined) throw new RangeError("a reversal exceeds what its recipients have left");
    slices[opts.ownerIndex] = (slices[opts.ownerIndex] ?? 0) + excess;
  }
  return slices;
}

const sumOf = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function reversal(
  i: PaymentReversalInput,
  kind: "refund" | "chargeback",
  extra: PostingEntry[],
  extraMeta: { disputeFeeCents?: number },
): Posting {
  assertCurrency(i.currency);
  const split = reversalSplit(i.original, i.cut, i.alreadyReversedCents, i.amountCents);
  const settlement = i.settlement ?? "cash";
  const settle = settlementAccount(i.provider, settlement);
  const owner = i.creatorUserId.toLowerCase();
  const total = splitAt(i.original.grossCents, i.original.grossCents, i.original.taxCents, i.cut).creatorCents;
  const shares = [...(i.shares ?? [{ userId: owner, role: "owner" as const, creatorCents: total }])].sort((a, b) =>
    compareUserIds(a.userId, b.userId),
  );
  if (shares.reduce((s, x) => s + x.creatorCents, 0) !== total) {
    throw new RangeError("the recorded shares do not sum to the payment's creator share");
  }
  const owners = shares.filter((s) => s.role === "owner");
  if (owners.length !== 1 || owners[0]?.userId.toLowerCase() !== owner) {
    throw new RangeError("a payment has exactly one owner share, the payment's owner");
  }
  const before = splitAt(i.alreadyReversedCents, i.original.grossCents, i.original.taxCents, i.cut).creatorCents;
  const reversedBy = i.reversedByRecipient;
  const slices = reversalSlices(shares, before, split.creatorCents, {
    reversed: reversedBy ? shares.map((s) => reversedBy[s.userId.toLowerCase()] ?? 0) : undefined,
    ownerIndex: shares.findIndex((s) => s.role === "owner"),
  });

  const entries: PostingEntry[] = [];
  const holdCode = accounts.creatorHold(owner);
  const ownMemo = holdMemo(i.paymentId, owner);
  const ownerLot = i.balances.holdLots.find((l) => l.paymentId === i.paymentId)?.cents ?? 0;
  const ownLot: Source = { code: holdCode, memo: ownMemo, available: ownerLot };
  const released: Source = {
    code: accounts.creator(owner),
    memo: "creator share reversed",
    available: i.balances.liabilityCents,
  };
  const others: Source[] = i.balances.holdLots
    .filter((l) => l.paymentId !== i.paymentId)
    .map((l) => ({ code: holdCode, memo: holdMemo(l.paymentId, owner), available: l.cents }));

  // 1. Every slice first from its recipient's own still-held lot of this payment.
  const fromOwnLot = shares.map((s, k) => {
    const slice = slices[k] ?? 0;
    if (s.role === "owner") return slice - drawFrom(slice, [ownLot], entries);
    const lot = Math.max(0, i.crewLots?.[s.userId.toLowerCase()] ?? 0);
    const used = Math.min(slice, lot);
    if (used > 0) {
      entries.push({ code: accounts.creatorHold(s.userId), amountCents: used, memo: holdMemo(i.paymentId, s.userId) });
    }
    return used;
  });
  // 2. Crew: nothing else. 3. The owner covers the rest, its own slice first, from today's order.
  const sources = kind === "refund" ? [ownLot, released, ...others] : [released, ownLot, ...others];
  const ownerIdx = shares.findIndex((s) => s.role === "owner");
  const ownerRest = (slices[ownerIdx] ?? 0) - (fromOwnLot[ownerIdx] ?? 0);
  const crewRest = shares.reduce(
    (sum, s, k) => (s.role === "crew" ? sum + (slices[k] ?? 0) - (fromOwnLot[k] ?? 0) : sum),
    0,
  );
  // 4. What the owner cannot cover: its own slice is an ordinary clawback receivable; what it
  //    absorbed for the crew goes to the split-shortfall suspense (decision 6), never to the crew.
  const receivableCents = drawFrom(ownerRest, sources, entries);
  const shortfallCents = drawFrom(crewRest, sources, entries);
  if (receivableCents > 0) {
    entries.push({ code: accounts.creatorReceivable(owner), amountCents: receivableCents, memo: "clawback shortfall" });
  }
  if (shortfallCents > 0) {
    entries.push({ code: accounts.splitShortfall(owner), amountCents: shortfallCents, memo: "split shortfall" });
  }

  return finish({
    kind,
    description: kind === "refund" ? "Payment refunded" : "Payment charged back",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `${kind}:${i.disputeId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    reversesId: i.originalTransactionId ?? null,
    metadata: ReversalMetaV2.parse({
      v: 2,
      disputeId: i.disputeId,
      creatorUserId: owner,
      provider: i.provider,
      settlement,
      revenueGrossCents: -i.amountCents,
      taxCents: negate(split.taxCents),
      creatorCents: negate(split.creatorCents),
      coopCents: negate(split.coopCents),
      receivableCents,
      ...extraMeta,
      shares: shares.map((s, k) => ({
        userId: s.userId.toLowerCase(),
        role: s.role,
        creatorCents: negate(slices[k] ?? 0),
        fromOwnLotCents: fromOwnLot[k] ?? 0,
        ownerCoveredCents: (slices[k] ?? 0) - (fromOwnLot[k] ?? 0),
      })),
    } satisfies ReversalMetaV2),
    entries: [
      { code: settle, amountCents: -i.amountCents, memo: `${kind} paid out` },
      { code: accounts.taxPayable(), amountCents: split.taxCents, memo: "tax reversed" },
      ...merged(entries),
      { code: accounts.platformCut(), amountCents: split.coopCents, memo: "co-op share reversed" },
      ...extra,
    ],
  });
}

/**
 * Full or partial refund. Reverses tax, creator share and cut proportionally. Each recipient's
 * slice comes first from their own still-held lot of this payment; the owner covers the rest
 * (its own lot, then released earnings, then other lots oldest first). What the owner cannot
 * cover becomes a clawback receivable (its own slice) or split-shortfall suspense (the crew's);
 * a crew recipient is never drawn on beyond their own lot and never owes the co-op.
 * Use `postReversal`, which reads these inputs from the ledger under locks.
 */
export function refund(i: PaymentReversalInput): Posting {
  return reversal(i, "refund", [], {});
}

/**
 * Chargeback with clawback: reversed like a refund (own lots first), but the owner covers the
 * rest from released earnings first, then its own lot, then other lots. Dispute fees are an
 * expense paid from the same settlement account.
 */
export function chargeback(i: PaymentReversalInput & { disputeFeeCents: number }): Posting {
  assertCents("disputeFee", i.disputeFeeCents);
  const settle = settlementAccount(i.provider, i.settlement ?? "cash");
  return reversal(
    i,
    "chargeback",
    [
      { code: accounts.paymentFees(), amountCents: i.disputeFeeCents, memo: "dispute fee" },
      { code: settle, amountCents: -i.disputeFeeCents, memo: "dispute fee" },
    ],
    { disputeFeeCents: i.disputeFeeCents },
  );
}

/** One recipient's slice of a chargeback being reversed (positive amounts, from its metadata). */
export interface ChargebackSlice {
  userId: string;
  role: "owner" | "crew";
  fromOwnLotCents: number;
  ownerCoveredCents: number;
  /**
   * A crew recipient withheld at reversal time (ADR 0013 decision 7): its own-lot part goes to its
   * split suspense, not its released earnings, so it cannot be paid out while restricted.
   */
  withheld?: boolean;
}

export interface ChargebackReversalInput {
  /** The dispute the chargeback was posted for. */
  disputeId: string;
  paymentId: string;
  /** The channel owner. */
  creatorUserId: string;
  provider: string;
  settlement?: Settlement;
  currency: string;
  occurredAt: Date;
  /** The original chargeback's amounts (positive), from its metadata. */
  chargeback: { amountCents: number; taxCents: number; creatorCents: number; coopCents: number };
  /** The chargeback's per-recipient slices; absent: the owner covered all of it. */
  slices?: readonly ChargebackSlice[];
  /** The owner's current clawback receivable (natural). */
  receivableCents: number;
  /** The owner's current split-shortfall suspense (natural). */
  splitShortfallCents?: number;
  /** Dispute fee returned by the provider, if any. */
  feeRefundCents?: number;
  chargebackTransactionId?: string;
}

/**
 * A chargeback the co-op won: the money comes back, tax and cut are restored, and each slice goes
 * back to where it came from (ADR 0013 decision 5). What a recipient's own lot gave is credited to
 * that recipient as released earnings (lots are never re-opened, and a decided dispute carries no
 * further hold risk), or to its split suspense if it is withheld right now (decision 7); what the owner covered first cancels the owner's split-shortfall suspense,
 * then its clawback receivable, then is credited as the owner's released earnings.
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
  const owner = i.creatorUserId.toLowerCase();
  const slices = [
    ...(i.slices ?? [{ userId: owner, role: "owner" as const, fromOwnLotCents: 0, ownerCoveredCents: c.creatorCents }]),
  ].sort((a, b) => compareUserIds(a.userId, b.userId));
  for (const s of slices) {
    assertCents("fromOwnLot", s.fromOwnLotCents);
    assertCents("ownerCovered", s.ownerCoveredCents);
  }
  if (slices.reduce((s, x) => s + x.fromOwnLotCents + x.ownerCoveredCents, 0) !== c.creatorCents) {
    throw new RangeError("the chargeback's slices must sum to its creator portion");
  }
  const settlement = i.settlement ?? "cash";
  const settle = settlementAccount(i.provider, settlement);
  const covered = slices.reduce((s, x) => s + x.ownerCoveredCents, 0);
  const cancelShortfall = Math.max(0, Math.min(covered, i.splitShortfallCents ?? 0));
  const cancelReceivable = Math.max(0, Math.min(covered - cancelShortfall, i.receivableCents));
  const restored: PostingEntry[] = slices.map((s) =>
    s.withheld && s.role === "crew"
      ? { code: accounts.splitSuspense(s.userId), amountCents: -s.fromOwnLotCents, memo: suspenseMemo(owner) }
      : { code: accounts.creator(s.userId), amountCents: -s.fromOwnLotCents, memo: "own lot restored" },
  );
  return finish({
    kind: "chargeback_reversal",
    description: "Chargeback won",
    refType: "payment",
    refId: i.paymentId,
    idempotencyKey: `chargeback-reversal:${i.disputeId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    reversesId: i.chargebackTransactionId ?? null,
    metadata: ReversalMetaV2.parse({
      v: 2,
      disputeId: i.disputeId,
      creatorUserId: owner,
      provider: i.provider,
      settlement,
      revenueGrossCents: c.amountCents,
      taxCents: c.taxCents,
      creatorCents: c.creatorCents,
      coopCents: c.coopCents,
      feeRefundCents: fee,
      // Negative: this restores what the chargeback took from each lot and what the owner covered.
      shares: slices.map((s) => ({
        userId: s.userId.toLowerCase(),
        role: s.role,
        creatorCents: s.fromOwnLotCents + s.ownerCoveredCents,
        fromOwnLotCents: negate(s.fromOwnLotCents),
        ownerCoveredCents: negate(s.ownerCoveredCents),
      })),
    } satisfies ReversalMetaV2),
    entries: [
      { code: settle, amountCents: c.amountCents, memo: "chargeback reversed" },
      { code: accounts.taxPayable(), amountCents: -c.taxCents, memo: "tax restored" },
      ...merged([
        ...restored,
        { code: accounts.splitShortfall(owner), amountCents: -cancelShortfall, memo: "split shortfall cancelled" },
        { code: accounts.creatorReceivable(owner), amountCents: -cancelReceivable, memo: "clawback cancelled" },
        {
          code: accounts.creator(owner),
          amountCents: -(covered - cancelShortfall - cancelReceivable),
          memo: "creator share restored",
        },
      ]),
      { code: accounts.platformCut(), amountCents: -c.coopCents, memo: "co-op share restored" },
      { code: settle, amountCents: fee, memo: "dispute fee returned" },
      { code: accounts.paymentFees(), amountCents: -fee, memo: "dispute fee returned" },
    ],
  });
}

// Split shortfall and suspense (ADR 0013 decisions 6, 7) --------------------------------------

export interface SplitShortfallWriteOffInput {
  /** The approved `split_writeoff_proposals` row. */
  proposalId: string;
  ownerUserId: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
}

/**
 * Write off an owner's uncollectable split shortfall to the co-op's own expense line, never
 * inside payment fees. Migration 0043 posts it only for an approved two-person proposal, and
 * only as exactly these two entries for the proposal's amount.
 */
export function splitShortfallWriteOff(i: SplitShortfallWriteOffInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  return finish({
    kind: "split_shortfall_writeoff",
    description: "Split shortfall written off",
    refType: "split_writeoff",
    refId: i.proposalId,
    idempotencyKey: `split-writeoff:${i.proposalId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { ownerUserId: i.ownerUserId.toLowerCase(), amountCents: i.amountCents },
    entries: [
      { code: accounts.splitShortfallWriteOff(), amountCents: i.amountCents, memo: "written off" },
      { code: accounts.splitShortfall(i.ownerUserId), amountCents: -i.amountCents, memo: "written off" },
    ],
  });
}

export interface SplitSuspenseInput {
  /** A fresh id for this release or forfeit; keys the posting. */
  actionId: string;
  recipientUserId: string;
  /** The withheld balance by the owner whose channel it came from (`suspenseMemo`). */
  byOwner: readonly { ownerUserId: string; cents: number }[];
  currency: string;
  occurredAt: Date;
}

function suspenseDebits(i: SplitSuspenseInput): { total: number; entries: PostingEntry[] } {
  let total = 0;
  const entries: PostingEntry[] = [];
  for (const o of [...i.byOwner].sort((a, b) => compareUserIds(a.ownerUserId, b.ownerUserId))) {
    assertCents("withheld", o.cents);
    if (o.cents === 0) continue;
    total += o.cents;
    entries.push({
      code: accounts.splitSuspense(i.recipientUserId),
      amountCents: o.cents,
      memo: suspenseMemo(o.ownerUserId),
    });
  }
  if (total === 0) throw new RangeError("nothing is withheld");
  return { total, entries };
}

/**
 * The recipient's restriction was lifted: their withheld shares move to their released earnings.
 * Migration 0043 refuses it without a treasurer's or admin's `audit_log` row for the transaction.
 */
export function splitSuspenseRelease(i: SplitSuspenseInput): Posting {
  const { total, entries } = suspenseDebits(i);
  return finish({
    kind: "split_suspense_release",
    description: "Withheld split shares released",
    refType: "split_suspense",
    refId: i.actionId,
    idempotencyKey: `split-suspense-release:${i.actionId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { recipientUserId: i.recipientUserId.toLowerCase(), amountCents: total },
    entries: [
      ...entries,
      { code: accounts.creator(i.recipientUserId), amountCents: -total, memo: "withheld share released" },
    ],
  });
}

/**
 * The recipient was deleted or permanently terminated: their withheld shares go back to the
 * owners whose channels they came from, as released earnings, never silently to the co-op.
 */
export function splitSuspenseForfeit(i: SplitSuspenseInput): Posting {
  const { total, entries } = suspenseDebits(i);
  return finish({
    kind: "split_suspense_forfeit",
    description: "Withheld split shares forfeited to the owner",
    refType: "split_suspense",
    refId: i.actionId,
    idempotencyKey: `split-suspense-forfeit:${i.actionId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: { recipientUserId: i.recipientUserId.toLowerCase(), amountCents: total },
    entries: [
      ...entries,
      ...i.byOwner
        .filter((o) => o.cents > 0)
        .map((o) => ({
          code: accounts.creator(o.ownerUserId),
          amountCents: -o.cents,
          memo: "withheld share forfeited",
        })),
    ],
  });
}

// Payouts -----------------------------------------------------------------------------------
//
// A payout moves in two steps so money promised to a creator can never be clawed back from
// under it: the batch *reserves* it (creator liability → payout clearing), and sending it
// moves clearing → cash. A chargeback after the batch therefore cannot touch reserved money
// (it books a receivable instead), and a failed payout *cancels* the reservation.

/** A creator's natural balances a payout nets: released earnings, the clawback receivable and split shortfall. */
export interface NettableBalances {
  liabilityCents: number;
  receivableCents: number;
  /** `asset:receivable:split-shortfall:<owner>` (ADR 0013 decision 6); absent = 0. */
  splitShortfallCents?: number;
}

/** What a creator can be paid now: released earnings net of what they owe the co-op (both receivables). */
export function availableToPay(b: NettableBalances): number {
  return b.liabilityCents - b.receivableCents - (b.splitShortfallCents ?? 0);
}

/** How much of each receivable a reservation nets: the creator receivable first, then split shortfall. */
export function nettedReceivables(b: NettableBalances): { receivableCents: number; splitShortfallCents: number } {
  const receivableCents = Math.max(0, Math.min(b.receivableCents, b.liabilityCents));
  const splitShortfallCents = Math.max(0, Math.min(b.splitShortfallCents ?? 0, b.liabilityCents - receivableCents));
  return { receivableCents, splitShortfallCents };
}

export interface PayoutReserveInput {
  payoutId: string;
  userId: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  /** Natural balances: released earnings, any clawback receivable and any split shortfall. */
  balances: NettableBalances;
  /** `payout.rules.minimumCents`. */
  minimumCents: number;
  /** Closing an account pays out whatever is left, even below the minimum. */
  closingAccount?: boolean;
}

/**
 * Reserve a payout. Any clawback receivable, then any split shortfall (ADR 0013 decision 6), is
 * netted against earnings in the same transaction, so after reserving everything available every
 * account is settled.
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
  const netted = nettedReceivables(i.balances);
  const offset = netted.receivableCents + netted.splitShortfallCents;
  return finish({
    kind: "payout_reserve",
    description: i.closingAccount ? "Final payout reserved (account closed)" : "Payout reserved",
    refType: "payout",
    refId: i.payoutId,
    idempotencyKey: `payout-reserve:${i.payoutId}`,
    currency: i.currency,
    occurredAt: i.occurredAt,
    metadata: {
      userId: i.userId,
      amountCents: i.amountCents,
      receivableNettedCents: netted.receivableCents,
      splitShortfallNettedCents: netted.splitShortfallCents,
    },
    entries: [
      { code: accounts.creator(i.userId), amountCents: i.amountCents + offset, memo: "reserved for payout" },
      { code: accounts.creatorReceivable(i.userId), amountCents: -netted.receivableCents, memo: "clawback netted" },
      {
        code: accounts.splitShortfall(i.userId),
        amountCents: -netted.splitShortfallCents,
        memo: "split shortfall netted",
      },
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
  /** The split shortfall netted when the payout was reserved (restored as owed again). */
  splitShortfallNettedCents?: number;
  currency: string;
  occurredAt: Date;
}

/** A payout failed or was cancelled before money left: undo the reservation exactly. */
export function payoutCancel(i: PayoutCancelInput): Posting {
  assertCents("amount", i.amountCents, { allowZero: false });
  assertCents("receivableNetted", i.receivableNettedCents);
  const shortfall = i.splitShortfallNettedCents ?? 0;
  assertCents("splitShortfallNetted", shortfall);
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
      { code: accounts.splitShortfall(i.userId), amountCents: shortfall, memo: "split shortfall restored" },
      {
        code: accounts.creator(i.userId),
        amountCents: -(i.amountCents + i.receivableNettedCents + shortfall),
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
