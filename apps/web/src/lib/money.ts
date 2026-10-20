// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for `/revenue`, `/treasury` and `/transparency`: month periods, the earned delta,
 * the CSV statement, tier and dispute validation, status badges and the transparency sums.
 * Money is integer cents with the DTO's currency throughout; nothing here divides cents.
 */
import type {
  RevenueLine,
  RevenueSummary,
  SubTierInfo,
  TransparencyMonth,
  TreasurerPayment,
  TreasurerPayout,
} from "@commonair/contracts/dto";
import { MONEY_LIMITS } from "@commonair/contracts/currency";
import type { PAYMENT_KINDS, PAYMENT_STATUSES, PAYOUT_STATUSES, REVENUE_LINE_TYPES } from "@commonair/contracts/enums";
import { formatMoney, type StatusTone } from "@commonair/ui";
import { notFound } from "@tanstack/react-router";
import type { z } from "zod";
import { t, type MessageKey } from "../i18n/index.ts";

export type RevenueSummaryDto = z.infer<typeof RevenueSummary>;
export type RevenueLineDto = z.infer<typeof RevenueLine>;
export type SubTierDto = z.infer<typeof SubTierInfo>;
export type TransparencyMonthDto = z.infer<typeof TransparencyMonth>;
export type TreasurerPaymentDto = z.infer<typeof TreasurerPayment>;
export type TreasurerPayoutDto = z.infer<typeof TreasurerPayout>;
export type RevenueLineType = (typeof REVENUE_LINE_TYPES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PaymentKind = (typeof PAYMENT_KINDS)[number];
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export interface MoneyDto {
  cents: number;
  currency: string;
}
export interface PayoutAccountDto {
  provider: "manual" | "stripe";
  payoutsEnabled: boolean;
  onboardingUrl: string | null;
  instructions: string | null;
}

// ── Roles ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The treasury is for treasurers only. Reads `role` when the session carries it (`Me.role`);
 * a session without one is never a treasurer.
 */
export function isTreasurer(me: object | null | undefined): boolean {
  return me !== null && me !== undefined && "role" in me && me.role === "treasurer";
}

/**
 * Route guard for the platform tools: resolves the session (on the server during SSR) and answers
 * anyone but a treasurer, signed out included, with the not-found page, so nothing renders for them.
 */
export async function requireTreasurer<T extends object>(load: () => Promise<T | null>): Promise<{ me: T }> {
  const me = await load();
  if (me === null || !isTreasurer(me)) throw notFound();
  return { me };
}

// ── Months (UTC) ──────────────────────────────────────────────────────────────────────────────

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const MONTH_NAME_KEYS: readonly MessageKey[] = [
  "money.month.1",
  "money.month.2",
  "money.month.3",
  "money.month.4",
  "money.month.5",
  "money.month.6",
  "money.month.7",
  "money.month.8",
  "money.month.9",
  "money.month.10",
  "money.month.11",
  "money.month.12",
];

/** `YYYY-MM` of the UTC month containing `ms`. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month as the API's `[from, to)` period, or null for anything but `YYYY-MM`. */
export function monthRange(key: string): { from: string; to: string } | null {
  const m = MONTH.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return {
    from: new Date(Date.UTC(year, month, 1)).toISOString(),
    to: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

/** "October 2026" from the catalog (no locale month formatter in the design system yet). */
export function monthLabel(key: string): string {
  const m = MONTH.exec(key);
  const name = m ? MONTH_NAME_KEYS[Number(m[2]) - 1] : undefined;
  if (!m || !name) return key;
  return t("money.monthLabel", { month: t(name), year: m[1] ?? "" });
}

export interface MonthOption {
  value: string;
  label: string;
}

/** The current UTC month and the `count - 1` before it, newest first. */
export function monthOptions(now: number, count = 12): MonthOption[] {
  const d = new Date(now);
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    const value = monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    return { value, label: monthLabel(value) };
  });
}

// ── Revenue figures ───────────────────────────────────────────────────────────────────────────

export interface EarnedDelta {
  direction: "up" | "down" | "flat";
  sentiment?: "positive" | "negative";
  label: string;
  /** `net − previousNet`, cents. */
  cents: number;
}

/** The period's net against the period before it, as a `StatCard` delta. */
export function earnedDelta(net: MoneyDto, previous: MoneyDto, locale: string): EarnedDelta {
  const cents = net.cents - previous.cents;
  const amount = formatMoney(Math.abs(cents), net.currency, locale);
  if (cents > 0) return { direction: "up", sentiment: "positive", cents, label: t("revenue.earned.up", { amount }) };
  if (cents < 0)
    return { direction: "down", sentiment: "negative", cents, label: t("revenue.earned.down", { amount }) };
  return { direction: "flat", cents, label: t("revenue.earned.flat") };
}

/** Whole percent of the payout minimum the available balance reaches, 0–100 (100 with no minimum). */
export function payoutProgress(availableCents: number, minimumCents: number): number {
  if (minimumCents <= 0) return 100;
  if (availableCents <= 0) return 0;
  return Math.min(100, Math.floor((availableCents * 100) / minimumCents));
}

// ── CSV statement ─────────────────────────────────────────────────────────────────────────────

/** Leading characters a spreadsheet may run as a formula (OWASP CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** A text cell: formula-injection safe (a leading `'`) and RFC 4180 quoted when needed. */
export function csvText(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** An integer cell (cents, counts), or empty for null. Integers are never formula-guarded. */
export function csvInteger(value: number | null): string {
  if (value === null) return "";
  if (!Number.isSafeInteger(value)) throw new RangeError(`csvInteger: not a safe integer: ${value}`);
  return String(value);
}

export const STATEMENT_COLUMNS = [
  "occurred_at",
  "type",
  "tier",
  "quantity",
  "from",
  "reference",
  "currency",
  "gross_cents",
  "deductions_cents",
  "net_cents",
  "net",
] as const;

/**
 * The period's revenue ledger as CSV: a header row, ISO 8601 UTC timestamps, cents as integers
 * plus one formatted net column. `from` is the payer's username; anonymous tips (`from: null`)
 * stay empty, and display names never appear.
 */
export function statementCsv(lines: readonly RevenueLineDto[], locale: string): string {
  const rows = lines.map((line) =>
    [
      csvText(new Date(line.occurredAt).toISOString()),
      csvText(line.type),
      csvInteger(line.tier),
      csvInteger(line.quantity),
      csvText(line.from?.username ?? ""),
      csvText(line.reference ?? ""),
      csvText(line.net.currency.toUpperCase()),
      csvInteger(line.gross?.cents ?? null),
      csvInteger(line.deductions?.cents ?? null),
      csvInteger(line.net.cents),
      csvText(formatMoney(line.net.cents, line.net.currency, locale)),
    ].join(","),
  );
  return [STATEMENT_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

export interface StatementPage {
  items: RevenueLineDto[];
  nextCursor: string | null;
}

/**
 * Every ledger line of the period, page by page, up to `maxPages`. `complete` is false when the
 * cap stopped it with pages left, so the caller never hands out a silently truncated statement.
 */
export async function collectStatement(
  load: (cursor: string | undefined) => Promise<StatementPage>,
  maxPages: number,
): Promise<{ lines: RevenueLineDto[]; complete: boolean }> {
  const lines: RevenueLineDto[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await load(cursor);
    lines.push(...page.items);
    if (!page.nextCursor) return { lines, complete: true };
    cursor = page.nextCursor;
  }
  return { lines, complete: false };
}

export function statementFilename(channel: string, month: string): string {
  return `revenue-${channel.replace(/[^a-z0-9_]/gi, "")}-${MONTH.test(month) ? month : "period"}.csv`;
}

// ── Tier editor ───────────────────────────────────────────────────────────────────────────────

export const TIERS = [1, 2, 3] as const;
export type TierNumber = (typeof TIERS)[number];
/** Starting prices for a channel without tiers (cents): within MONEY_LIMITS and increasing. */
export const DEFAULT_TIER_PRICES: Record<TierNumber, number> = { 1: 500, 2: 1000, 3: 2500 };

export interface TierDraft {
  tier: TierNumber;
  name: string;
  priceCents: number;
  benefits: string;
}

export function tierDrafts(tiers: readonly SubTierDto[]): TierDraft[] {
  return TIERS.map((tier) => {
    const found = tiers.find((x) => x.tier === tier);
    return found
      ? { tier, name: found.name, priceCents: found.price.cents, benefits: found.benefits }
      : { tier, name: "", priceCents: DEFAULT_TIER_PRICES[tier], benefits: "" };
  });
}

/**
 * The tier editor's currency: the stored tiers' own, else the instance's. Never waits on
 * `money.revenue`, so the editor shows even when the summary fails to load.
 */
export function tierEditorCurrency(tiers: readonly SubTierDto[], instanceCurrency: string): string {
  return tiers[0]?.price.currency ?? instanceCurrency;
}

export interface TierFieldErrors {
  name?: string;
  price?: string;
  benefits?: string;
}

/**
 * The API's rules (`money.setTiers`): three tiers, each priced within MONEY_LIMITS, strictly
 * increasing; plus a name. Returns per-tier errors (empty object = valid).
 */
export function validateTiers(drafts: readonly TierDraft[]): Partial<Record<TierNumber, TierFieldErrors>> {
  const errors: Partial<Record<TierNumber, TierFieldErrors>> = {};
  const add = (tier: TierNumber, field: keyof TierFieldErrors, message: string) => {
    const current = errors[tier] ?? {};
    current[field] ??= message;
    errors[tier] = current;
  };
  for (const tier of TIERS) {
    const draft = drafts.find((d) => d.tier === tier);
    if (!draft) {
      add(tier, "name", t("revenue.tiers.error.missing"));
      continue;
    }
    const name = draft.name.trim();
    if (name === "") add(tier, "name", t("revenue.tiers.error.nameRequired"));
    else if (name.length > MONEY_LIMITS.tierNameMaxLength)
      add(tier, "name", t("revenue.tiers.error.nameTooLong", { max: MONEY_LIMITS.tierNameMaxLength }));
    if (draft.benefits.length > MONEY_LIMITS.tierBenefitsMaxLength)
      add(tier, "benefits", t("revenue.tiers.error.benefitsTooLong", { max: MONEY_LIMITS.tierBenefitsMaxLength }));
    if (
      !Number.isSafeInteger(draft.priceCents) ||
      draft.priceCents < MONEY_LIMITS.tierMinCents ||
      draft.priceCents > MONEY_LIMITS.tierMaxCents
    )
      add(tier, "price", t("revenue.tiers.error.priceRange"));
    const lower = drafts.find((d) => d.tier === tier - 1);
    if (lower && draft.priceCents <= lower.priceCents) add(tier, "price", t("revenue.tiers.error.priceOrder"));
  }
  return errors;
}

export function tiersValid(drafts: readonly TierDraft[]): boolean {
  return Object.keys(validateTiers(drafts)).length === 0;
}

/** `money.setTiers` input tiers, trimmed, in the instance currency. */
export function tiersInput(drafts: readonly TierDraft[], currency: string): SubTierDto[] {
  return TIERS.map((tier) => {
    const d = drafts.find((x) => x.tier === tier) ?? { name: "", priceCents: 0, benefits: "" };
    return { tier, name: d.name.trim(), price: { cents: d.priceCents, currency }, benefits: d.benefits.trim() };
  });
}

// ── Treasury ──────────────────────────────────────────────────────────────────────────────────

/** What a refund or chargeback can still take back, cents. */
export function refundableCents(payment: Pick<TreasurerPaymentDto, "amount" | "refunded">): number {
  return Math.max(0, payment.amount.cents - payment.refunded.cents);
}

export function canDispute(payment: Pick<TreasurerPaymentDto, "status" | "amount" | "refunded">): boolean {
  return (payment.status === "succeeded" || payment.status === "partially_refunded") && refundableCents(payment) > 0;
}

export const DISPUTE_REASON_MAX = 500;
export const PAYOUT_REFERENCE_MAX = 200;
export const COST_CATEGORY_MAX = 40;
export const COST_DESCRIPTION_MAX = 200;
export const REFERENCE_SEARCH_MAX = 64;

/** An error message for a dispute amount, or null when 1 ≤ amount ≤ refundable. */
export function disputeAmountError(amountCents: number, refundable: number): string | null {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > refundable)
    return t("treasury.dispute.amountRange");
  return null;
}

/** Cost categories become ledger account codes: the API's lowercase slug. */
export const COST_CATEGORY = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Expense categories outside infrastructure (the API refuses them for `recordCost`). */
export const RESERVED_COST_CATEGORIES: readonly string[] = ["payment-fees"];

/** An error for a typed cost category (already trimmed and lowercased), or null when it is usable. */
export function costCategoryError(slug: string): string | null {
  if (!COST_CATEGORY.test(slug)) return t("treasury.cost.categoryInvalid");
  if (RESERVED_COST_CATEGORIES.includes(slug)) return t("treasury.cost.categoryReserved");
  return null;
}

export const USERNAME = /^[a-z0-9_]{3,25}$/;

/** The payout account form's rule (as the API's): a username, and a reference once payouts are enabled. */
export function payoutAccountValid(input: { username: string; reference: string; payoutsEnabled: boolean }): boolean {
  return USERNAME.test(input.username) && (!input.payoutsEnabled || input.reference.trim() !== "");
}

/** The UTC month containing `now`, for `treasurer.recordCost`. */
export function currentMonthPeriod(now: number): { periodStart: string; periodEnd: string } {
  const range = monthRange(monthKey(now));
  // monthKey always yields a valid key, so the range exists.
  return { periodStart: range?.from ?? "", periodEnd: range?.to ?? "" };
}

/** Reference search as typed (`ca-abcd 1234` → `CA-ABCD1234`); the API normalizes again. */
export function normalizeReference(text: string): string {
  return text.toUpperCase().replace(/\s+/g, "").slice(0, REFERENCE_SEARCH_MAX);
}

// ── Status badges ─────────────────────────────────────────────────────────────────────────────

export interface BadgeView {
  label: string;
  tone: StatusTone;
}

const REVENUE_LINE_BADGES: Record<RevenueLineType, { key: MessageKey; tone: StatusTone }> = {
  subscription: { key: "revenue.type.subscription", tone: "success" },
  gift: { key: "revenue.type.gift", tone: "info" },
  tip: { key: "revenue.type.tip", tone: "success" },
  refund: { key: "revenue.type.refund", tone: "warning" },
  chargeback: { key: "revenue.type.chargeback", tone: "danger" },
  payout: { key: "revenue.type.payout", tone: "neutral" },
};

export function revenueLineBadge(type: RevenueLineType): BadgeView {
  const b = REVENUE_LINE_BADGES[type];
  return { label: t(b.key), tone: b.tone };
}

const PAYMENT_STATUS_BADGES: Record<PaymentStatus, { key: MessageKey; tone: StatusTone }> = {
  pending: { key: "treasury.paymentStatus.pending", tone: "warning" },
  succeeded: { key: "treasury.paymentStatus.succeeded", tone: "success" },
  failed: { key: "treasury.paymentStatus.failed", tone: "neutral" },
  refunded: { key: "treasury.paymentStatus.refunded", tone: "neutral" },
  partially_refunded: { key: "treasury.paymentStatus.partiallyRefunded", tone: "warning" },
  charged_back: { key: "treasury.paymentStatus.chargedBack", tone: "danger" },
};

export function paymentStatusBadge(status: PaymentStatus): BadgeView {
  const b = PAYMENT_STATUS_BADGES[status];
  return { label: t(b.key), tone: b.tone };
}

const PAYMENT_KIND_KEYS: Record<PaymentKind, MessageKey> = {
  subscription: "treasury.kind.subscription",
  tip: "treasury.kind.tip",
  membership_share: "treasury.kind.membershipShare",
};

/** "Subscription", "2 gift subs · tier 1", "Tip". */
export function paymentDescription(payment: Pick<TreasurerPaymentDto, "kind" | "tier" | "quantity">): string {
  if (payment.kind === "subscription" && payment.quantity > 1)
    return t("treasury.kind.gifts", { count: payment.quantity, tier: payment.tier ?? "" });
  if (payment.kind === "subscription" && payment.tier !== null)
    return t("treasury.kind.subscriptionTier", { tier: payment.tier });
  return t(PAYMENT_KIND_KEYS[payment.kind]);
}

const PAYOUT_STATUS_BADGES: Record<PayoutStatus, { key: MessageKey; tone: StatusTone }> = {
  pending: { key: "treasury.payoutStatus.pending", tone: "warning" },
  scheduled: { key: "treasury.payoutStatus.scheduled", tone: "info" },
  paid: { key: "treasury.payoutStatus.paid", tone: "success" },
  failed: { key: "treasury.payoutStatus.failed", tone: "danger" },
  held: { key: "treasury.payoutStatus.held", tone: "neutral" },
};

export function payoutStatusBadge(status: PayoutStatus): BadgeView {
  const b = PAYOUT_STATUS_BADGES[status];
  return { label: t(b.key), tone: b.tone };
}

const HOLD_REASON_KEYS: Record<string, MessageKey> = {
  payout_account_not_ready: "treasury.holdReason.accountNotReady",
};

export function holdReasonLabel(reason: string): string {
  const key = HOLD_REASON_KEYS[reason];
  return key ? t(key) : t("treasury.holdReason.other", { code: reason });
}

// ── Transparency ──────────────────────────────────────────────────────────────────────────────

export const TRANSPARENCY_PERIODS = [3, 6, 12] as const;
export type TransparencyPeriod = (typeof TRANSPARENCY_PERIODS)[number];

const PERIOD_KEYS: Record<TransparencyPeriod, MessageKey> = {
  3: "transparency.period.3",
  6: "transparency.period.6",
  12: "transparency.period.12",
};

export function transparencyPeriodOptions(): MonthOption[] {
  return TRANSPARENCY_PERIODS.map((months) => ({ value: String(months), label: t(PERIOD_KEYS[months]) }));
}

export function parseTransparencyPeriod(value: string): TransparencyPeriod | null {
  return TRANSPARENCY_PERIODS.find((p) => String(p) === value) ?? null;
}

export function monthCosts(month: Pick<TransparencyMonthDto, "costs">): number {
  return month.costs.reduce((sum, c) => sum + c.amount.cents, 0);
}

export interface TransparencyTotals {
  currency: string;
  revenue: number;
  payouts: number;
  costs: number;
  surplus: number;
}

export function transparencyTotals(
  months: readonly TransparencyMonthDto[],
  fallbackCurrency: string,
): TransparencyTotals {
  return months.reduce<TransparencyTotals>(
    (acc, m) => ({
      currency: acc.currency,
      revenue: acc.revenue + m.revenue.cents,
      payouts: acc.payouts + m.streamerPayouts.cents,
      costs: acc.costs + monthCosts(m),
      surplus: acc.surplus + m.surplus.cents,
    }),
    { currency: months[0]?.revenue.currency ?? fallbackCurrency, revenue: 0, payouts: 0, costs: 0, surplus: 0 },
  );
}

export interface FlowSegment {
  id: string;
  label: string;
  value: number;
}

/**
 * Where the revenue went: the creators' share (revenue − co-op cut), each cost category, and what
 * the co-op kept (the surplus; a deficit shows as nothing kept). Integer cents.
 */
export function transparencyFlow(months: readonly TransparencyMonthDto[]): FlowSegment[] {
  const creators = months.reduce((sum, m) => sum + m.revenue.cents - m.coopRetained.cents, 0);
  const byCategory = new Map<string, number>();
  for (const m of months)
    for (const c of m.costs) byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + c.amount.cents);
  const surplus = months.reduce((sum, m) => sum + m.surplus.cents, 0);
  return [
    { id: "creators", label: t("transparency.flow.creators"), value: Math.max(0, creators) },
    ...[...byCategory].map(([category, cents]) => ({
      id: `cost-${category}`,
      label: t("transparency.flow.cost", { category }),
      value: cents,
    })),
    { id: "retained", label: t("transparency.flow.retained"), value: Math.max(0, surplus) },
  ];
}

export interface EgressShare {
  relayBytes: number;
  totalBytes: number;
  /** Whole percent of all egress served by member relays (0 with no egress). */
  relayPercent: number;
}

export function egressShare(months: readonly Pick<TransparencyMonthDto, "egressBySource">[]): EgressShare {
  let relayBytes = 0;
  let totalBytes = 0;
  for (const m of months)
    for (const [source, bytes] of Object.entries(m.egressBySource)) {
      totalBytes += bytes;
      if (source === "relay") relayBytes += bytes;
    }
  return { relayBytes, totalBytes, relayPercent: totalBytes > 0 ? Math.round((relayBytes * 100) / totalBytes) : 0 };
}
