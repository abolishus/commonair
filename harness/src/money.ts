// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure money helpers for the `e4b-money` scenario (docs/testing/e4b-selectors.md): the ledger's
 * split and reversal rounding rules re-implemented independently (so the scenario checks the
 * platform rather than trusting it), the figures the scenario expects at each step, parsing of
 * `data-*` cents attributes, chat event frames and payment references.
 *
 * All arithmetic is integer cents. Fractions are resolved to integer millionths once and
 * multiplied with BigInt, exactly like `@commonair/ledger`.
 */
import { MANUAL_REFERENCE_PATTERN, minorUnits } from "@commonair/contracts/currency";

export const VIA = ["web", "api"] as const;
export type Via = (typeof VIA)[number];

/** `--set via=<web|api>`. */
export function parseVia(value: string): Via {
  const v = value.trim().toLowerCase();
  if ((VIA as readonly string[]).includes(v)) return v as Via;
  throw new Error(`--set via=${value}: expected one of ${VIA.join(", ")}`);
}

export const PROVIDERS = ["manual", "stripe"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** `--set provider=<manual|stripe>`: which payment adapter the stack under test runs. */
export function parseProvider(value: string): Provider {
  const v = value.trim().toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(v)) return v as Provider;
  throw new Error(`--set provider=${value}: expected one of ${PROVIDERS.join(", ")}`);
}

// ---------------------------------------------------------------- split rules

/** The `platform.cut` setting (as `money.support` reports it). */
export interface Cut {
  streamerShare: number;
  coopShare: number;
}

export const FRACTION_SCALE = 1_000_000n;

/** A fraction in [0, 1] as integer millionths (0.9 → 900000). */
export function toMicros(fraction: number): bigint {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`fraction must be within [0, 1], got ${fraction}`);
  }
  return BigInt(Math.round(fraction * Number(FRACTION_SCALE)));
}

function assertCents(name: string, v: number): void {
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`${name} must be a non-negative integer of cents`);
}

function assertCut(cut: Cut): void {
  if (toMicros(cut.streamerShare) + toMicros(cut.coopShare) !== FRACTION_SCALE) {
    throw new RangeError(`cut shares must sum to 1 (got ${cut.streamerShare} + ${cut.coopShare})`);
  }
}

/** floor(amount × numerator / denominator) for non-negative integers, exact. */
export function mulDivFloor(amount: number, numerator: bigint, denominator: bigint): number {
  assertCents("amount", amount);
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  return Number((BigInt(amount) * numerator) / denominator);
}

export interface Split {
  taxCents: number;
  creatorCents: number;
  coopCents: number;
}

/** Net of tax: the creator gets floor(net × streamerShare), the co-op the remainder. */
export function splitNet(netCents: number, cut: Cut): { creatorCents: number; coopCents: number } {
  assertCents("net", netCents);
  assertCut(cut);
  const creatorCents = mulDivFloor(netCents, toMicros(cut.streamerShare), FRACTION_SCALE);
  return { creatorCents, coopCents: netCents - creatorCents };
}

/** How a payment of `grossCents` (including `taxCents`) is posted. */
export function splitPayment(grossCents: number, taxCents: number, cut: Cut): Split {
  assertCents("gross", grossCents);
  assertCents("tax", taxCents);
  if (taxCents > grossCents) throw new RangeError("tax cannot exceed gross");
  return { taxCents, ...splitNet(grossCents - taxCents, cut) };
}

/** The split of the first `cumulative` cents of a payment's gross (tax pro rata, floored). */
function splitAt(cumulative: number, grossCents: number, taxCents: number, cut: Cut): Split {
  const tax = grossCents === 0 ? 0 : mulDivFloor(taxCents, BigInt(cumulative), BigInt(grossCents));
  return { taxCents: tax, ...splitNet(cumulative - tax, cut) };
}

/**
 * The portions a reversal of `amountCents` takes back when `alreadyReversedCents` was reversed
 * before: split(cumulative) − split(already), so slices always add up to the original split.
 */
export function reversalSplit(
  original: { grossCents: number; taxCents: number },
  cut: Cut,
  alreadyReversedCents: number,
  amountCents: number,
): Split {
  assertCents("alreadyReversed", alreadyReversedCents);
  assertCents("amount", amountCents);
  if (amountCents === 0) throw new RangeError("amount must be positive");
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

// ---------------------------------------------------------------- scenario expectations

export type Tier = 1 | 2 | 3;

export interface ScenarioPlan {
  /** Prices the streamer sets for tiers 1–3, cents. */
  tierPrices: readonly [number, number, number];
  cut: Cut;
  /** Tier A subscribes to. */
  subTier: Tier;
  /** Tier and count A gifts. */
  giftTier: Tier;
  giftCount: number;
  tipCents: number;
}

export interface PaymentFigures {
  grossCents: number;
  split: Split;
}

export interface LedgerRowExpectation {
  type: "subscription" | "gift" | "tip" | "refund" | "chargeback";
  tier: number | null;
  quantity: number;
  gross: number;
  deductions: number;
  net: number;
}

export interface RevenueExpectation {
  available: number;
  held: number;
  owed: number;
  earned: number;
  bySource: { subscriptions: number; gifts: number; tips: number };
  activeByTier: Record<Tier, number>;
  ledger: LedgerRowExpectation[];
}

export interface ScenarioExpectation {
  sub: PaymentFigures;
  gift: PaymentFigures;
  tip: PaymentFigures;
  /** Step 5: everything confirmed, nothing reversed. */
  afterPayments: RevenueExpectation;
  /** Step 6: the tip refunded in full, the subscription charged back in full. */
  afterReversals: RevenueExpectation;
  /** Step 8: this month's transparency revenue added by the scenario (creator + co-op, net of reversals). */
  transparencyRevenueDelta: number;
}

/** Manual payments carry no tax and no fee. */
const MANUAL_TAX = 0;

function paymentRow(type: LedgerRowExpectation["type"], tier: number | null, quantity: number, f: PaymentFigures) {
  return {
    type,
    tier,
    quantity,
    gross: f.grossCents,
    deductions: -(f.split.taxCents + f.split.coopCents),
    net: f.split.creatorCents,
  } satisfies LedgerRowExpectation;
}

function reversalRow(
  type: "refund" | "chargeback",
  tier: number | null,
  quantity: number,
  amount: number,
  s: Split,
): LedgerRowExpectation {
  return { type, tier, quantity, gross: -amount, deductions: s.taxCents + s.coopCents, net: -s.creatorCents };
}

export function priceOf(plan: ScenarioPlan, tier: Tier): number {
  return plan.tierPrices[tier - 1] as number;
}

/** Every figure the scenario asserts in steps 5–8, computed from the plan and the cut. */
export function expectedFigures(plan: ScenarioPlan): ScenarioExpectation {
  if (plan.giftCount < 1) throw new RangeError("giftCount must be at least 1");
  const figures = (gross: number): PaymentFigures => ({
    grossCents: gross,
    split: splitPayment(gross, MANUAL_TAX, plan.cut),
  });
  const sub = figures(priceOf(plan, plan.subTier));
  const gift = figures(priceOf(plan, plan.giftTier) * plan.giftCount);
  const tip = figures(plan.tipCents);

  const active = (): Record<Tier, number> => ({ 1: 0, 2: 0, 3: 0 });
  const activeAfterPayments = active();
  activeAfterPayments[plan.subTier] += 1;
  activeAfterPayments[plan.giftTier] += plan.giftCount;
  const activeAfterReversals = active();
  activeAfterReversals[plan.giftTier] += plan.giftCount;

  const creatorTotal = sub.split.creatorCents + gift.split.creatorCents + tip.split.creatorCents;
  const payments = [
    paymentRow("subscription", plan.subTier, 1, sub),
    paymentRow("gift", plan.giftTier, plan.giftCount, gift),
    paymentRow("tip", null, 1, tip),
  ];
  const afterPayments: RevenueExpectation = {
    available: 0,
    held: creatorTotal,
    owed: 0,
    earned: creatorTotal,
    bySource: {
      subscriptions: sub.split.creatorCents,
      gifts: gift.split.creatorCents,
      tips: tip.split.creatorCents,
    },
    activeByTier: activeAfterPayments,
    ledger: payments,
  };

  const tipRefund = reversalSplit({ grossCents: tip.grossCents, taxCents: MANUAL_TAX }, plan.cut, 0, tip.grossCents);
  const subChargeback = reversalSplit(
    { grossCents: sub.grossCents, taxCents: MANUAL_TAX },
    plan.cut,
    0,
    sub.grossCents,
  );
  // Everything is still inside the hold, so both clawbacks come out of the hold and nothing is owed.
  const reversed = tipRefund.creatorCents + subChargeback.creatorCents;
  const afterReversals: RevenueExpectation = {
    available: 0,
    held: creatorTotal - reversed,
    owed: 0,
    earned: creatorTotal - reversed,
    bySource: {
      subscriptions: sub.split.creatorCents - subChargeback.creatorCents,
      gifts: gift.split.creatorCents,
      tips: tip.split.creatorCents - tipRefund.creatorCents,
    },
    activeByTier: activeAfterReversals,
    ledger: [
      ...payments,
      reversalRow("refund", null, 1, tip.grossCents, tipRefund),
      reversalRow("chargeback", plan.subTier, 1, sub.grossCents, subChargeback),
    ],
  };

  const netOfTax = (f: PaymentFigures) => f.grossCents - f.split.taxCents;
  const reversedNet = tip.grossCents - tipRefund.taxCents + (sub.grossCents - subChargeback.taxCents);
  return {
    sub,
    gift,
    tip,
    afterPayments,
    afterReversals,
    transparencyRevenueDelta: netOfTax(sub) + netOfTax(gift) + netOfTax(tip) - reversedNet,
  };
}

/** A tier's monthly creator share: per subscription, or floored over the whole tier (both are defensible readings). */
export function monthlyShareCandidates(priceCents: number, active: number, cut: Cut): number[] {
  const per = splitNet(priceCents, cut).creatorCents * active;
  const whole = splitNet(priceCents * active, cut).creatorCents;
  return [...new Set([per, whole])];
}

// ---------------------------------------------------------------- ledger rows

export interface ObservedLedgerRow {
  type: string;
  tier: number | null;
  quantity: number | null;
  gross: number | null;
  deductions: number | null;
  net: number;
}

/** Rows whose gross + deductions is not their net (payouts have neither and are skipped). */
export function inconsistentLedgerRows<R extends ObservedLedgerRow>(rows: readonly R[]): R[] {
  return rows.filter((r) => r.gross !== null && r.deductions !== null && r.gross + r.deductions !== r.net);
}

/**
 * Expected rows that have no matching observed row (each observed row matches at most once).
 * Order does not matter: the ledger lists newest first.
 */
export function missingLedgerRows(
  expected: readonly LedgerRowExpectation[],
  observed: readonly ObservedLedgerRow[],
): LedgerRowExpectation[] {
  const pool = [...observed];
  const missing: LedgerRowExpectation[] = [];
  for (const e of expected) {
    const i = pool.findIndex(
      (o) =>
        o.type === e.type &&
        o.net === e.net &&
        o.gross === e.gross &&
        o.deductions === e.deductions &&
        (o.quantity === null || o.quantity === e.quantity) &&
        (e.tier === null || o.tier === e.tier),
    );
    if (i < 0) missing.push(e);
    else pool.splice(i, 1);
  }
  return missing;
}

export function sumNet(rows: readonly { net: number }[]): number {
  return rows.reduce((s, r) => s + r.net, 0);
}

/** One ledger transaction's entry sum in one currency (from step 9's query). */
export interface LedgerSumRow {
  transactionId: string;
  refId: string | null;
  kind: string;
  /** Unique per posting; reversals carry `${kind}:${disputeId}` (packages/ledger rules). */
  idempotencyKey: string;
  currency: string;
  sum: string | number | bigint;
}

/**
 * A refund/chargeback posts against the payment (ref_type "payment", ref_id = payment id), so
 * the dispute id appears only in the posting's idempotency key, `${kind}:${disputeId}`.
 */
export function disputePostingKey(d: { id: string; kind: string }): string {
  return `${d.kind}:${d.id}`;
}

/** Whether the dispute's reversal posting is among the rows (exact idempotency-key match). */
export function disputeReachedLedger(
  rows: readonly LedgerSumRow[],
  d: { id: string; paymentId: string; kind: string },
): boolean {
  const key = disputePostingKey(d);
  return rows.some((r) => r.idempotencyKey === key && r.refId === d.paymentId);
}

/** Transactions that do not sum to zero in some currency. */
export function unbalancedTransactions(rows: readonly LedgerSumRow[]): LedgerSumRow[] {
  return rows.filter((r) => BigInt(r.sum) !== 0n);
}

// ---------------------------------------------------------------- parsing

/** A signed integer cents attribute; empty or missing → null. Anything else is a contract breach. */
export function parseCents(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const v = value.trim();
  if (!/^-?\d+$/.test(v)) throw new Error(`not integer cents: "${value}"`);
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`cents out of range: "${value}"`);
  return n === 0 ? 0 : n;
}

/** Like parseCents but the attribute must be present. */
export function requireCents(value: string | null | undefined, what: string): number {
  const n = parseCents(value);
  if (n === null) throw new Error(`${what}: missing cents`);
  return n;
}

/** A tier as chat events or the web carry it: `2`, or Twitch-style `2000`. */
export function parseTier(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (value === "") return null;
  const n = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(n)) return null;
  if (n >= 1 && n <= 3) return n;
  if (n === 1000 || n === 2000 || n === 3000) return n / 1000;
  return null;
}

/** Cents as typed into a currency field (`500` → `5.00` for usd, `500` for jpy). */
export function centsToInput(cents: number, currency: string): string {
  assertCents("cents", cents);
  const d = minorUnits(currency);
  if (d === 0) return String(cents);
  const s = String(cents).padStart(d + 1, "0");
  return `${s.slice(0, -d)}.${s.slice(-d)}`;
}

/**
 * The `CA-XXXXXXXX` reference in what a payer or the UI shows (case, spaces, dashes and the
 * look-alikes I/L → 1, O → 0 are forgiven, like the API's normalizer), or null.
 */
export function parseReference(text: string): string | null {
  const direct = normalizeReference(text);
  if (direct) return direct;
  for (const m of text.matchAll(/CA[\s-]?[0-9A-Z]{4}[\s-]?[0-9A-Z]{4}/gi)) {
    const ref = normalizeReference(m[0]);
    if (ref) return ref;
  }
  return null;
}

function normalizeReference(input: string): string | null {
  const compact = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/^CA/, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  const ref = `CA-${compact}`;
  return MANUAL_REFERENCE_PATTERN.test(ref) ? ref : null;
}

/** Two fractions are the same cut setting (compared as millionths, never as floats). */
export function sameFraction(a: number | string | null | undefined, b: number): boolean {
  if (a === null || a === undefined || a === "") return false;
  const n = typeof a === "number" ? a : Number(a);
  if (!Number.isFinite(n) || n < 0 || n > 1) return false;
  return toMicros(n) === toMicros(b);
}

// ---------------------------------------------------------------- chat events

export const MONEY_EVENT_TYPES = ["channel.subscribe", "channel.subscription.gift", "channel.tip"] as const;
export type MoneyEventType = (typeof MONEY_EVENT_TYPES)[number];

/** A money event in chat, the same whether read from a `chat-event` row or an `op: "event"` frame. */
export interface MoneyChatEvent {
  type: string;
  /** Login, or "" when anonymous. */
  user: string;
  tier: number | null;
  /** Tips. */
  cents: number | null;
  /** Gifts. */
  total: number | null;
}

/** From the `chat-event` row's `data-*` attributes. */
export function chatEventFromAttributes(a: {
  type: string | null;
  user: string | null;
  tier: string | null;
  cents: string | null;
  total: string | null;
}): MoneyChatEvent {
  return {
    type: a.type ?? "",
    user: a.user ?? "",
    tier: parseTier(a.tier),
    cents: parseCents(a.cents),
    total: parseCents(a.total),
  };
}

/** From an `op: "event"` frame: `data` is the event's EventSub-style payload. */
export function chatEventFromFrame(type: string, data: Record<string, unknown>): MoneyChatEvent {
  const anonymous = data.is_anonymous === true;
  const login = typeof data.user_login === "string" && !anonymous ? data.user_login : "";
  const amount = data.amount as { value?: unknown } | undefined;
  const cents = typeof amount?.value === "number" && Number.isSafeInteger(amount.value) ? amount.value : null;
  const total = typeof data.total === "number" && Number.isSafeInteger(data.total) ? data.total : null;
  return { type, user: login, tier: parseTier(data.tier), cents, total };
}

/** UTC `YYYY-MM` of a moment (the transparency and revenue month key). */
export function utcMonth(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}
