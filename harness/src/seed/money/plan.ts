// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-money's plan: every payout account, revenue split, checkout (subscription, gift, tip), how
 * it settles, what happens to it afterwards (refund, chargeback, cancel, lapse), the fraud flags and
 * the treasurer's monthly costs, as specs keyed by handle. Pure and deterministic for a given PRNG,
 * scale, accounts and `now`. All amounts are integer cents in one explicit currency.
 *
 * The plan keeps clear of the worker's fraud scan (ADR 0036) on purpose: every payer stays at or
 * under `velocityMaxPayments`, nobody younger than `newPayerAccountDays` pays, and no payee's gross
 * concentrates on three payers, except the one velocity payer that exists to raise one flag.
 */
import { MONEY_LIMITS } from "@commonair/contracts/currency";
import { PAYMENT_FRAUD_RULES, type SplitBasis } from "@commonair/contracts/enums";
import { splitNetN } from "@commonair/ledger";
import { type Cut, type Split, splitPayment, utcMonth } from "../../money.ts";
import type { Rng } from "../prng.ts";
import type { SeedScale } from "../scale.ts";
import type { SeedAccountKind } from "../types.ts";
import {
  ANONYMOUS_TIP_SHARE,
  COST_LINES,
  PARTIAL_REFUND_REASON,
  REFUND_REASON,
  CHARGEBACK_REASON,
  TIER_WEIGHTS,
  TIP_AMOUNTS,
  TIP_MESSAGES,
} from "./content.ts";

export const DAY_MS = 86_400_000;

export type Tier = 1 | 2 | 3;
export type PaymentKind = "sub" | "gift" | "tip";
/** How a checkout ends: confirmed, left pending for the treasurer, or abandoned until it expires. */
export type Settle = "paid" | "pending" | "abandoned";
export type ChargebackOutcome = "open" | "won" | "lost";
export type Reversal =
  | { kind: "refund"; cents: number; reason: string }
  | { kind: "chargeback"; outcome: ChargebackOutcome; reason: string };
/** What a paid self subscription does next: nothing, cancel at period end, or miss its renewal. */
export type Lifecycle = "none" | "cancel_at_period_end" | "lapse";
export type SubscriptionStatus = "incomplete" | "active" | "past_due" | "canceled" | "expired";

/** Fixed streamers that take money, in revenue rank order (streamer3 is the new channel). */
export const FIXED_PAYEES = ["streamer1", "streamer2", "council1", "council2"] as const;
export const NEW_STREAMER = "streamer3";
/** The fixed heavy supporter. */
export const SUPPORTER = "viewer1";
/** Fallback payer when there are no bulk viewers (a fixed viewer whose purpose allows it). */
export const FALLBACK_PAYER = "viewer2";
/** The crew member on streamer1's (accepted) and streamer2's (proposed) splits. */
export const CREW = "chanmod";

/** Bulk payers stay well under the velocity rule (it flags more than `velocityMaxPayments`). */
export const MAX_PAYMENTS_PER_PAYER = PAYMENT_FRAUD_RULES.velocityMaxPayments - 2;
/** The one deliberate velocity payer's tips: one over the rule. */
export const VELOCITY_TIPS = PAYMENT_FRAUD_RULES.velocityMaxPayments + 1;
/** Bulk payers drawn, relative to the fewest that could carry every bulk payment. */
export const PAYER_SLACK = 1.25;
/** Payers must be older than the concentration rule's "new payer" age. */
export const MIN_PAYER_AGE_DAYS = PAYMENT_FRAUD_RULES.newPayerAccountDays + 1;

/** Base counts at factor 1 (`small`): enough for every list view to paginate. */
export const BASE = {
  subs: 24,
  gifts: 4,
  tips: 30,
  pendingSubs: 2,
  pendingTips: 3,
  abandonedSubs: 1,
  abandonedTips: 1,
  cancelAtPeriodEnd: 3,
  lapses: 2,
  /** Each reversal case below, per factor. */
  reversals: 1,
} as const;

export interface MoneyAccount {
  handle: string;
  kind: SeedAccountKind;
  createdAt: Date;
}

export interface MoneyPlanInput {
  accounts: readonly MoneyAccount[];
  /** Channel owners that stream (`store.channels`), fixed ones first. */
  streamers: readonly string[];
  /** `${payeeHandle}\0${userHandle}`: banned or timed out in that channel (never a gift recipient). */
  banned?: ReadonlySet<string>;
  /** Every seeded channel's tier prices (seed-social sets the same three everywhere). */
  tierPrices: readonly [number, number, number];
  currency: string;
}

export interface PaymentSpec {
  /** Stable per plan (`m0001`): names the spec in errors. */
  key: string;
  payer: string;
  /** The channel owner paid. */
  payee: string;
  kind: PaymentKind;
  tier: Tier | null;
  /** Named gift recipient (one gift sub). */
  giftTo: string | null;
  cents: number;
  currency: string;
  message: string;
  anonymous: boolean;
  settle: Settle;
  reversal: Reversal | null;
  lifecycle: Lifecycle;
  /** One of the deliberate velocity payer's tips. */
  velocity: boolean;
}

export interface SplitSpec {
  owner: string;
  basis: SplitBasis;
  crew: { handle: string; bps: number }[];
  /** Every recipient accepts (else the version stays proposed). */
  accept: boolean;
}

export interface PayoutAccountSpec {
  handle: string;
  enabled: boolean;
}

export interface FraudFlagSpec {
  payee: string;
  /** The treasurer's first review and the admin's decision; null leaves the flag open. */
  decision: "confirm" | "clear" | null;
}

export interface CostSpec {
  periodStart: Date;
  periodEnd: Date;
  category: string;
  description: string;
  cents: number;
}

export interface MoneyPlan {
  currency: string;
  revenuePeriod: string;
  payoutAccounts: PayoutAccountSpec[];
  splits: SplitSpec[];
  payments: PaymentSpec[];
  velocity: { payer: string; payee: string } | null;
  /** Raised by the treasurer through the API (the velocity flag comes from the worker's scan). */
  flags: FraudFlagSpec[];
  costs: CostSpec[];
}

// ---------------------------------------------------------------- helpers

function weighted<T>(r: Rng, items: readonly { item: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let x = r.next() * total;
  for (const i of items) {
    x -= i.weight;
    if (x < 0) return i.item;
  }
  const last = items[items.length - 1];
  if (!last) throw new RangeError("weighted pick from an empty list");
  return last.item;
}

/** A power-law pick over ranked items (rank 0 most likely), by binary search on the cumulative weights. */
function rankedPicker<T>(items: readonly T[]): (r: Rng) => T {
  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += 1 / (i + 1);
    cum.push(total);
  }
  return (r) => {
    const x = r.next() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] ?? 0) > x) hi = mid;
      else lo = mid + 1;
    }
    const v = items[lo];
    if (v === undefined) throw new RangeError("ranked pick from an empty list");
    return v;
  };
}

/** UTC start of the month `offset` months from `at`'s month. */
export function monthStart(at: Date, offset = 0): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));
}

const pairKey = (a: string, b: string) => `${a}\0${b}`;

/** Payers with room for more payments; picks are random among them, honouring a per-pick filter. */
class PayerPool {
  private readonly open: string[];
  private readonly used = new Map<string, number>();

  constructor(
    payers: readonly string[],
    private readonly cap: number,
  ) {
    this.open = [...payers];
  }

  pick(r: Rng, ok: (payer: string) => boolean): string | null {
    for (let tries = 0; tries < 24 && this.open.length > 0; tries++) {
      const p = this.open[r.int(0, this.open.length - 1)];
      if (p !== undefined && ok(p)) return this.take(p);
    }
    const p = this.open.find(ok);
    return p === undefined ? null : this.take(p);
  }

  private take(p: string): string {
    const n = (this.used.get(p) ?? 0) + 1;
    this.used.set(p, n);
    if (n >= this.cap) {
      const i = this.open.indexOf(p);
      if (i >= 0) this.open.splice(i, 1);
    }
    return p;
  }
}

// ---------------------------------------------------------------- the plan

export function planMoney(rng: Rng, scale: SeedScale, now: Date, input: MoneyPlanInput): MoneyPlan {
  const { accounts, currency, tierPrices } = input;
  if (!/^[a-z]{3}$/.test(currency)) throw new RangeError(`currency must be a lowercase ISO code, got "${currency}"`);
  for (const p of tierPrices) {
    if (!Number.isSafeInteger(p) || p < MONEY_LIMITS.tierMinCents) throw new RangeError(`bad tier price ${p}`);
  }
  const banned = input.banned ?? new Set<string>();
  const byHandle = new Map(accounts.map((a) => [a.handle, a]));
  const has = (h: string) => byHandle.has(h);
  const priceOf = (t: Tier) => tierPrices[t - 1] as number;
  const factor = scale.factor;
  const t = now.getTime();

  const bulkStreamers = input.streamers.filter((h) => byHandle.get(h)?.kind === "bulk-streamer");
  const payees = [...FIXED_PAYEES.filter((h) => input.streamers.includes(h)), ...bulkStreamers];
  const bulkViewers = accounts.filter((a) => a.kind === "bulk-viewer").map((a) => a.handle);
  const oldEnough = (h: string) => {
    const a = byHandle.get(h);
    return a !== undefined && t - a.createdAt.getTime() >= MIN_PAYER_AGE_DAYS * DAY_MS;
  };
  const eligible = bulkViewers.filter(oldEnough);

  // The velocity payer is a bulk viewer kept out of every other payment; its payee a bulk streamer.
  const rv = rng.fork("velocity");
  const velocityPayer = eligible.length > 1 && bulkStreamers.length > 0 ? rv.pick(eligible) : null;
  const velocityPayee = velocityPayer ? rv.pick(bulkStreamers) : null;
  // Just enough payers for the bulk payments (with slack for the one-subscription-per-channel
  // rule): every payer signs in, and sign-ins are rate limited per address.
  const bulkPayments =
    (BASE.subs +
      BASE.gifts +
      BASE.tips +
      BASE.pendingSubs +
      BASE.pendingTips +
      BASE.abandonedSubs +
      BASE.abandonedTips +
      6 * BASE.reversals) *
    factor;
  const payerCount = Math.ceil((bulkPayments / MAX_PAYMENTS_PER_PAYER) * PAYER_SLACK) + 2;
  const payerList = [
    ...rng
      .fork("payers")
      .shuffle(eligible.filter((h) => h !== velocityPayer))
      .slice(0, payerCount),
    ...(has(FALLBACK_PAYER) && oldEnough(FALLBACK_PAYER) ? [FALLBACK_PAYER] : []),
  ];
  const pool = new PayerPool(payerList, MAX_PAYMENTS_PER_PAYER);
  const recipients = [...bulkViewers, ...(has(FALLBACK_PAYER) ? [FALLBACK_PAYER] : [])];
  /** One subscription (any status) per subscriber and channel, so slot conflicts cannot happen. */
  const slots = new Set<string>();
  const freeSlot = (subscriber: string, payee: string) =>
    subscriber !== payee && !slots.has(pairKey(subscriber, payee));
  const pickPayee = rankedPicker(payees);

  const payments: Omit<PaymentSpec, "key">[] = [];
  const base = {
    giftTo: null,
    currency,
    message: "",
    anonymous: false,
    settle: "paid" as Settle,
    reversal: null,
    lifecycle: "none" as Lifecycle,
    velocity: false,
  };
  const sub = (payer: string, payee: string, tier: Tier, extra: Partial<PaymentSpec> = {}) => {
    slots.add(pairKey(payer, payee));
    payments.push({ ...base, payer, payee, kind: "sub", tier, cents: priceOf(tier), ...extra });
  };
  const gift = (payer: string, payee: string, tier: Tier, to: string) => {
    slots.add(pairKey(to, payee));
    payments.push({ ...base, payer, payee, kind: "gift", tier, giftTo: to, cents: priceOf(tier) });
  };
  const tip = (r: Rng, payer: string, payee: string, extra: Partial<PaymentSpec> = {}) => {
    const message = r.pick(TIP_MESSAGES);
    payments.push({
      ...base,
      payer,
      payee,
      kind: "tip",
      tier: null,
      cents: weighted(
        r,
        TIP_AMOUNTS.map((a) => ({ item: a.cents, weight: a.weight })),
      ),
      message,
      anonymous: r.chance(ANONYMOUS_TIP_SHARE),
      ...extra,
    });
  };
  const pickTier = (r: Rng): Tier =>
    weighted(
      r,
      TIER_WEIGHTS.map((w) => ({ item: w.tier, weight: w.weight })),
    );
  const pickRecipient = (r: Rng, gifter: string, payee: string): string | null => {
    const ok = (h: string) => h !== gifter && freeSlot(h, payee) && !banned.has(pairKey(payee, h));
    for (let i = 0; i < 24 && recipients.length > 0; i++) {
      const h = r.pick(recipients);
      if (ok(h)) return h;
    }
    return recipients.find(ok) ?? null;
  };

  // viewer1: all three tiers on the fixed streamers, each lifecycle, a gift, several tips.
  if (has(SUPPORTER)) {
    const r1 = rng.fork("supporter");
    const fixed = (h: string) => input.streamers.includes(h);
    if (fixed("streamer1")) sub(SUPPORTER, "streamer1", 3);
    if (fixed("streamer2")) sub(SUPPORTER, "streamer2", 2);
    if (fixed("council1")) sub(SUPPORTER, "council1", 1, { lifecycle: "lapse" });
    if (fixed("council2")) sub(SUPPORTER, "council2", 2, { lifecycle: "cancel_at_period_end" });
    if (fixed(NEW_STREAMER)) sub(SUPPORTER, NEW_STREAMER, 1, { settle: "abandoned" });
    if (fixed("streamer1")) {
      const to = pickRecipient(r1, SUPPORTER, "streamer1");
      if (to) gift(SUPPORTER, "streamer1", 1, to);
    }
    const tips: [string, number, string][] = [
      ["streamer2", 1_000, "Great stream today!"],
      ["streamer2", 500, "For the coffee fund"],
      ["streamer1", 2_000, "Love the new overlay"],
      ["council1", 300, "GG"],
    ];
    for (const [payee, cents, message] of tips) {
      if (!fixed(payee)) continue;
      payments.push({ ...base, payer: SUPPORTER, payee, kind: "tip", tier: null, cents, message });
    }
  }

  // Bulk subscriptions in a power law over channels; some cancel at period end, some lapse.
  const rs = rng.fork("subs");
  let cancels = BASE.cancelAtPeriodEnd * factor;
  let lapses = BASE.lapses * factor;
  for (let i = 0; i < BASE.subs * factor && payees.length > 0; i++) {
    const payee = pickPayee(rs);
    const payer = pool.pick(rs, (p) => freeSlot(p, payee));
    if (!payer) continue;
    let lifecycle: Lifecycle = "none";
    if (cancels > 0) {
      lifecycle = "cancel_at_period_end";
      cancels--;
    } else if (lapses > 0) {
      lifecycle = "lapse";
      lapses--;
    }
    sub(payer, payee, pickTier(rs), { lifecycle });
  }
  const rg = rng.fork("gifts");
  for (let i = 0; i < BASE.gifts * factor && payees.length > 0; i++) {
    const payee = pickPayee(rg);
    const payer = pool.pick(rg, (p) => p !== payee);
    if (!payer) continue;
    const to = pickRecipient(rg, payer, payee);
    if (to) gift(payer, payee, pickTier(rg), to);
  }
  const rt = rng.fork("tips");
  for (let i = 0; i < BASE.tips * factor && payees.length > 0; i++) {
    const payee = pickPayee(rt);
    const payer = pool.pick(rt, (p) => p !== payee);
    if (payer) tip(rt, payer, payee);
  }

  // Checkouts the treasurer still has to confirm, and ones nobody pays until they expire.
  const rp = rng.fork("pending");
  const unsettled = (n: number, kind: "sub" | "tip", settle: Settle) => {
    for (let i = 0; i < n * factor && payees.length > 0; i++) {
      const payee = pickPayee(rp);
      if (kind === "tip") {
        const payer = pool.pick(rp, (p) => p !== payee);
        if (payer) tip(rp, payer, payee, { settle });
      } else {
        const payer = pool.pick(rp, (p) => freeSlot(p, payee));
        if (payer) sub(payer, payee, pickTier(rp), { settle });
      }
    }
  };
  unsettled(BASE.pendingSubs, "sub", "pending");
  unsettled(BASE.pendingTips, "tip", "pending");
  unsettled(BASE.abandonedSubs, "sub", "abandoned");
  unsettled(BASE.abandonedTips, "tip", "abandoned");

  // Reversals: refunds (full and partial) and chargebacks in every outcome.
  const rr = rng.fork("reversals");
  const reversalPayees = payees.filter((h) => h !== "streamer1");
  const pickReversalPayee = rankedPicker(reversalPayees.length > 0 ? reversalPayees : payees);
  for (let i = 0; i < BASE.reversals * factor && payees.length > 0; i++) {
    const cases: { kind: "sub" | "tip"; reversal: (cents: number) => Reversal }[] = [
      { kind: "sub", reversal: (c) => ({ kind: "refund", cents: c, reason: REFUND_REASON }) },
      { kind: "sub", reversal: () => ({ kind: "chargeback", outcome: "lost", reason: CHARGEBACK_REASON }) },
      { kind: "tip", reversal: (c) => ({ kind: "refund", cents: c, reason: REFUND_REASON }) },
      {
        kind: "tip",
        reversal: (c) => ({ kind: "refund", cents: Math.floor(c / 2), reason: PARTIAL_REFUND_REASON }),
      },
      { kind: "tip", reversal: () => ({ kind: "chargeback", outcome: "open", reason: CHARGEBACK_REASON }) },
      { kind: "tip", reversal: () => ({ kind: "chargeback", outcome: "won", reason: CHARGEBACK_REASON }) },
    ];
    for (const c of cases) {
      const payee = pickReversalPayee(rr);
      if (c.kind === "sub") {
        const payer = pool.pick(rr, (p) => freeSlot(p, payee));
        if (!payer) continue;
        const tier = pickTier(rr);
        sub(payer, payee, tier, { reversal: c.reversal(priceOf(tier)) });
      } else {
        const payer = pool.pick(rr, (p) => p !== payee);
        if (!payer) continue;
        // At least 2 × the minimum, so half of it is still a valid partial refund.
        tip(rr, payer, payee);
        const last = payments[payments.length - 1];
        if (last) {
          last.cents = Math.max(last.cents, 2 * MONEY_LIMITS.tipMinCents);
          last.reversal = c.reversal(last.cents);
        }
      }
    }
  }

  // The velocity payer: one over the rule, all to one payee, so the scan flags exactly that payee.
  if (velocityPayer && velocityPayee) {
    for (let i = 0; i < VELOCITY_TIPS; i++)
      payments.push({
        ...base,
        payer: velocityPayer,
        payee: velocityPayee,
        kind: "tip",
        tier: null,
        cents: MONEY_LIMITS.tipMinCents * (1 + (i % 3)),
        velocity: true,
      });
  }

  // Fraud flags the treasurer raises: one confirmed (held until an admin releases it), one cleared.
  const rf = rng.fork("flags");
  const flagPool = rf.shuffle(bulkStreamers.filter((h) => h !== velocityPayee));
  const fallback = ["council2", "council1"].filter((h) => input.streamers.includes(h));
  const flagPayees = [...flagPool, ...fallback].slice(0, 2);
  const decisions: FraudFlagSpec["decision"][] = ["confirm", "clear"];
  const flags = flagPayees.map((payee, i) => ({ payee, decision: decisions[i] ?? null }));

  // Payout accounts: streamer1 ready, streamer2 not (its payouts hold), the crew and the council ready.
  const payoutAccounts: PayoutAccountSpec[] = [
    { handle: "streamer1", enabled: true },
    { handle: "streamer2", enabled: false },
    { handle: CREW, enabled: true },
    { handle: "council1", enabled: true },
    { handle: "council2", enabled: true },
  ].filter((a) => has(a.handle));

  const splits: SplitSpec[] = [];
  if (has(CREW) && input.streamers.includes("streamer1"))
    splits.push({ owner: "streamer1", basis: "all", crew: [{ handle: CREW, bps: 2_000 }], accept: true });
  if (has(CREW) && input.streamers.includes("streamer2"))
    splits.push({ owner: "streamer2", basis: "tips", crew: [{ handle: CREW, bps: 1_500 }], accept: false });

  return {
    currency,
    revenuePeriod: utcMonth(now),
    payoutAccounts,
    splits,
    payments: payments.map((p, i) => ({ ...p, key: `m${String(i + 1).padStart(5, "0")}` })),
    velocity: velocityPayer && velocityPayee ? { payer: velocityPayer, payee: velocityPayee } : null,
    flags,
    costs: planCosts(rng.fork("costs"), scale, now, byHandle.get("treasurer")?.createdAt ?? null),
  };
}

/**
 * One month of costs per `historyDays / 30`, never before the treasurer's account (the cost was
 * recorded by them, so a period older than the account would read as backdated by someone absent).
 */
export function planCosts(rng: Rng, scale: SeedScale, now: Date, treasurerCreatedAt: Date | null): CostSpec[] {
  const months = Math.max(1, Math.ceil(scale.historyDays / 30));
  const floor = treasurerCreatedAt ? treasurerCreatedAt.getTime() + DAY_MS : Number.NEGATIVE_INFINITY;
  const out: CostSpec[] = [];
  for (let k = months - 1; k >= 0; k--) {
    const start = monthStart(now, -k);
    const end = monthStart(now, -k + 1);
    if (end.getTime() <= floor) continue;
    const periodStart = new Date(Math.max(start.getTime(), floor));
    if (periodStart.getTime() > now.getTime()) continue;
    for (const line of COST_LINES) {
      // ±10–15 % month to month, in whole cents.
      const pct = rng.int(88, 115);
      out.push({
        periodStart,
        periodEnd: end,
        category: line.category,
        description: line.description,
        cents: Math.floor((line.baseCents * pct) / 100),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- derived views

/** Where a planned subscription ends up once the seed and the worker are done with it. */
export function subscriptionStatus(p: PaymentSpec): SubscriptionStatus {
  if (p.settle === "abandoned") return "expired";
  if (p.settle === "pending") return "incomplete";
  if (p.reversal?.kind === "chargeback") return "canceled";
  if (p.reversal?.kind === "refund" && p.reversal.cents >= p.cents) return "canceled";
  if (p.lifecycle === "lapse") return "past_due";
  return "active";
}

export interface SubscriptionEntry {
  channelSlug: string;
  tier: number;
  status: SubscriptionStatus;
}

/** `store.extra.money.subscriptionsByUser`: subscriber handle → their planned subscriptions. */
export function subscriptionsByUser(
  plan: Pick<MoneyPlan, "payments">,
  slugOf: (handle: string) => string,
): Record<string, SubscriptionEntry[]> {
  const out: Record<string, SubscriptionEntry[]> = {};
  for (const p of plan.payments) {
    if (p.tier === null) continue;
    const who = p.kind === "gift" ? p.giftTo : p.kind === "sub" ? p.payer : null;
    if (!who) continue;
    (out[who] ??= []).push({ channelSlug: slugOf(p.payee), tier: p.tier, status: subscriptionStatus(p) });
  }
  return out;
}

/** Creator handles with at least one confirmed payment (`store.extra.money.paidCreators`). */
export function paidCreators(plan: Pick<MoneyPlan, "payments">): string[] {
  return [...new Set(plan.payments.filter((p) => p.settle === "paid").map((p) => p.payee))].sort();
}

const basisCovers = (basis: SplitBasis, kind: PaymentKind) =>
  basis === "all" || (basis === "tips" ? kind === "tip" : kind !== "tip");

export interface PaymentFigure {
  key: string;
  payee: string;
  grossCents: number;
  split: Split;
  /** The creator share divided by the accepted split (the owner alone without one). */
  shares: { handle: string; role: "owner" | "crew"; bps: number; creatorCents: number }[];
}

/**
 * The ledger's figures for every confirmed payment, with no tax (manual) and today's cut. With a
 * split the creator share is divided by basis points (`splitNetN`); which recipient gets a leftover
 * cent depends on the order of real user ids, so here handles stand in and only the parts' sum and
 * bounds are exact.
 */
export function paymentFigures(plan: Pick<MoneyPlan, "payments" | "splits">, cut: Cut): PaymentFigure[] {
  return plan.payments
    .filter((p) => p.settle === "paid")
    .map((p) => {
      const split = splitPayment(p.cents, 0, cut);
      const version = plan.splits.find((s) => s.accept && s.owner === p.payee && basisCovers(s.basis, p.kind));
      const crew = version ? version.crew.map((c) => ({ userId: c.handle, bps: c.bps })) : [];
      const shares = splitNetN(split.creatorCents, p.payee, crew).map((s) => ({
        handle: s.userId,
        role: s.role,
        bps: s.bps,
        creatorCents: s.creatorCents,
      }));
      return { key: p.key, payee: p.payee, grossCents: p.cents, split, shares };
    });
}

export interface FraudExposure {
  /** Payees the velocity rule would flag. */
  velocity: string[];
  /** Payees the concentration rule would flag. */
  concentration: string[];
}

/**
 * What the worker's scan would flag in this plan, conservatively: every payment counts in one
 * window (the seed runs in minutes) and at its full gross. Pure.
 */
export function fraudExposure(
  plan: Pick<MoneyPlan, "payments">,
  accounts: readonly MoneyAccount[],
  now: Date,
): FraudExposure {
  const rules = PAYMENT_FRAUD_RULES;
  const created = new Map(accounts.map((a) => [a.handle, a.createdAt.getTime()]));
  const paid = plan.payments.filter((p) => p.settle === "paid" && p.kind !== "gift");
  const gifts = plan.payments.filter((p) => p.settle === "paid" && p.kind === "gift");
  const all = [...paid, ...gifts];
  const byPayer = new Map<string, PaymentSpec[]>();
  for (const p of all) byPayer.set(p.payer, [...(byPayer.get(p.payer) ?? []), p]);
  const velocity = new Set<string>();
  for (const list of byPayer.values())
    if (list.length > rules.velocityMaxPayments) for (const p of list) velocity.add(p.payee);

  const byPayee = new Map<string, { gross: number; payers: Map<string, number>; fresh: number }>();
  for (const p of all) {
    const g = byPayee.get(p.payee) ?? { gross: 0, payers: new Map<string, number>(), fresh: 0 };
    g.gross += p.cents;
    if (!p.anonymous) g.payers.set(p.payer, (g.payers.get(p.payer) ?? 0) + p.cents);
    const c = created.get(p.payer);
    if (c !== undefined && now.getTime() - c < rules.newPayerAccountDays * DAY_MS) g.fresh += p.cents;
    byPayee.set(p.payee, g);
  }
  const concentration: string[] = [];
  const reaches = (part: number, whole: number, share: number) =>
    BigInt(part) * 1_000_000n >= BigInt(whole) * BigInt(Math.round(share * 1_000_000));
  for (const [payee, g] of byPayee) {
    if (g.gross < rules.concentrationMinGrossCents) continue;
    const top = [...g.payers.values()]
      .sort((a, b) => b - a)
      .slice(0, rules.concentrationTopN)
      .reduce((s, c) => s + c, 0);
    if (reaches(top, g.gross, rules.concentrationShare) || reaches(g.fresh, g.gross, rules.newPayerShare))
      concentration.push(payee);
  }
  return { velocity: [...velocity].sort(), concentration: concentration.sort() };
}

/** Rows each table should get from the plan when every step runs (stripe-only steps included). */
export function plannedCounts(plan: MoneyPlan): Record<string, number> {
  const p = plan.payments;
  return {
    payments: p.length,
    subscriptions: p.filter((x) => x.kind !== "tip").length,
    tips: p.filter((x) => x.kind === "tip").length,
    disputes: p.filter((x) => x.reversal !== null).length,
    payout_accounts: plan.payoutAccounts.length,
    infra_costs: plan.costs.length,
    revenue_splits: plan.splits.length,
    revenue_split_shares: plan.splits.reduce((n, s) => n + s.crew.length, 0),
    revenue_split_acceptances: plan.splits.filter((s) => s.accept).reduce((n, s) => n + s.crew.length, 0),
    payment_fraud_flags: plan.flags.length + (plan.velocity ? 1 : 0),
  };
}
