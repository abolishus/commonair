// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Support dialog and subscription-settings logic, pure for unit tests: which tabs are open,
 * gift and tip validation, the total in integer cents, the creator / co-op split of it, the
 * checkout request, and the status and error views. Amounts are integer minor units throughout.
 */
import type { StatusTone } from "@commonair/ui";
import { t, type MessageKey } from "../i18n/index.ts";
import type { Api } from "./api.ts";
import { errorCode } from "./api.ts";

export type SupportInfo = Awaited<ReturnType<Api["money"]["support"]>>;
export type CheckoutResult = Awaited<ReturnType<Api["money"]["subscribe"]>>;
export type SubscriptionDto = Awaited<ReturnType<Api["money"]["mySubscriptions"]>>[number];
export type SubscriptionStatus = SubscriptionDto["status"];
export type TierNumber = 1 | 2 | 3;
export type SubscribeInput = Parameters<Api["money"]["subscribe"]>[0];
export type TipInput = Parameters<Api["money"]["tip"]>[0];

export const SUPPORT_TABS = ["sub", "gift", "tip"] as const;
export type SupportTab = (typeof SUPPORT_TABS)[number];

export interface TabState {
  enabled: boolean;
  /** Why the tab is closed, shown next to it. */
  reason: MessageKey | null;
}

/** Statuses that block a second self-subscription (the API answers CONFLICT). */
const HOLDING: readonly SubscriptionStatus[] = ["active", "past_due"];

/** Subscriptions and gifts need all three tiers; tips need none. */
export function tabAvailability(info: SupportInfo): Record<SupportTab, TabState> {
  const open: TabState = { enabled: true, reason: null };
  if (info.viewer?.isOwner) {
    const closed: TabState = { enabled: false, reason: "support.reason.owner" };
    return { sub: closed, gift: closed, tip: closed };
  }
  const noTiers = info.tiers.length < 3;
  const held = info.viewer?.subscription ?? null;
  return {
    sub: noTiers
      ? { enabled: false, reason: "support.reason.noTiers" }
      : held && HOLDING.includes(held.status)
        ? { enabled: false, reason: "support.reason.subscribed" }
        : open,
    gift: noTiers ? { enabled: false, reason: "support.reason.noTiers" } : open,
    tip: open,
  };
}

/** The first open tab, so the dialog never opens on a disabled one. */
export function initialTab(available: Record<SupportTab, TabState>): SupportTab {
  return SUPPORT_TABS.find((tab) => available[tab].enabled) ?? "tip";
}

export function tierPrice(info: SupportInfo, tier: TierNumber): number | null {
  return info.tiers.find((entry) => entry.tier === tier)?.price.cents ?? null;
}

// ---- gifts ----

export type RecipientMode = "random" | "viewer";

export interface GiftDraft {
  /** The count input as typed; the presets fill it. */
  count: string;
  mode: RecipientMode;
  to: string;
}

export const GIFT_PRESETS = [1, 5, 10, 25] as const;

/** Presets the channel allows (a lower `maxCount` drops the bigger ones). */
export function giftPresets(maxCount: number): number[] {
  return GIFT_PRESETS.filter((count) => count <= maxCount);
}

/** Same rule as the contract's `Slug`. */
const USERNAME = /^[a-z0-9_]{3,25}$/;

export function normalizeUsername(text: string): string {
  return text.trim().replace(/^@/, "").toLowerCase();
}

/** A whole number typed as plain digits, or null. */
export function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

/** How many subs the draft buys: one for a named viewer, else the typed count when valid. */
export function giftCount(draft: GiftDraft, maxCount: number): number | null {
  if (draft.mode === "viewer") return 1;
  const count = parseCount(draft.count);
  return count !== null && count >= 1 && count <= maxCount ? count : null;
}

export function giftError(draft: GiftDraft, maxCount: number): MessageKey | null {
  if (draft.mode === "viewer") return USERNAME.test(normalizeUsername(draft.to)) ? null : "support.gift.invalidTo";
  return giftCount(draft, maxCount) === null ? "support.gift.invalidCount" : null;
}

// ---- tips ----

export interface TipDraft {
  cents: number;
  message: string;
  anonymous: boolean;
}

export const TIP_PRESETS_CENTS = [200, 500, 1000, 2000] as const;

export function tipPresets(limits: SupportInfo["tip"]): number[] {
  return TIP_PRESETS_CENTS.filter((cents) => cents >= limits.minCents && cents <= limits.maxCents);
}

export function tipError(draft: TipDraft, limits: SupportInfo["tip"]): MessageKey | null {
  if (!Number.isSafeInteger(draft.cents) || draft.cents < limits.minCents || draft.cents > limits.maxCents)
    return "support.tip.invalidAmount";
  return null;
}

/** Longer than the limit can only happen if the input's `maxLength` was bypassed; still refuse it. */
export function tipMessageTooLong(draft: TipDraft, limits: SupportInfo["tip"]): boolean {
  return draft.message.length > limits.messageMaxLength;
}

// ---- totals and split ----

export interface SupportDraft {
  tab: SupportTab;
  tier: TierNumber;
  gift: GiftDraft;
  tip: TipDraft;
}

/** What the submit button will charge, in cents; null while the draft is invalid. */
export function supportTotal(info: SupportInfo, draft: SupportDraft): number | null {
  const available = tabAvailability(info);
  if (!available[draft.tab].enabled) return null;
  if (draft.tab === "tip")
    return tipError(draft.tip, info.tip) || tipMessageTooLong(draft.tip, info.tip) ? null : draft.tip.cents;
  const price = tierPrice(info, draft.tier);
  if (price === null) return null;
  if (draft.tab === "sub") return price;
  if (giftError(draft.gift, info.gift.maxCount)) return null;
  const count = giftCount(draft.gift, info.gift.maxCount);
  if (count === null) return null;
  const total = price * count;
  return Number.isSafeInteger(total) ? total : null;
}

const FRACTION_SCALE = 1_000_000n;

/**
 * Creator and co-op parts of `totalCents` with the ledger's rounding (`splitNet` in
 * @commonair/ledger): the creator gets floor(total × streamerShare) via integer millionths,
 * the co-op the rest, so the parts always sum to the total. Tax and fees are 0 under the
 * manual adapter, so nothing else is shown.
 */
export function splitCents(totalCents: number, split: SupportInfo["split"]): { creator: number; coop: number } {
  const total = Math.max(0, Math.trunc(totalCents));
  const share = Math.min(1, Math.max(0, Number.isFinite(split.streamerShare) ? split.streamerShare : 0));
  const micros = BigInt(Math.round(share * Number(FRACTION_SCALE)));
  const creator = Number((BigInt(total) * micros) / FRACTION_SCALE);
  return { creator, coop: total - creator };
}

/** Whole-percent labels for the split (the bar's own label), summing to 100. */
export function splitPercents(split: SupportInfo["split"]): { creator: number; coop: number } {
  const creator = Math.round(Math.min(1, Math.max(0, split.streamerShare)) * 100);
  return { creator, coop: 100 - creator };
}

// ---- checkout ----

export type CheckoutRequest = { kind: "subscribe"; input: SubscribeInput } | { kind: "tip"; input: TipInput };

/** The API call for a valid draft; null while invalid. `returnPath` brings Stripe back here. */
export function checkoutRequest(
  channel: string,
  info: SupportInfo,
  draft: SupportDraft,
  returnPath: string,
): CheckoutRequest | null {
  if (supportTotal(info, draft) === null) return null;
  if (draft.tab === "tip")
    return {
      kind: "tip",
      input: {
        channel,
        amountCents: draft.tip.cents,
        message: draft.tip.message.trim(),
        anonymous: draft.tip.anonymous,
        returnPath,
      },
    };
  if (draft.tab === "sub") return { kind: "subscribe", input: { channel, tier: draft.tier, returnPath } };
  const count = giftCount(draft.gift, info.gift.maxCount) ?? 1;
  const gift = draft.gift.mode === "viewer" ? { count: 1, to: normalizeUsername(draft.gift.to) } : { count };
  return { kind: "subscribe", input: { channel, tier: draft.tier, gift, returnPath } };
}

/** Error codes whose server message is written for the payer (e.g. how many gift recipients exist). */
const SHOWN_CODES = new Set(["PRECONDITION_FAILED", "CONFLICT", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND"]);

/**
 * The `support-error` text: the API's message for a refused checkout, the session message when
 * the session is gone, or the generic catalog string.
 */
export function checkoutErrorText(err: unknown): { key: MessageKey } | { text: string } {
  const code = errorCode(err);
  if (code === "UNAUTHORIZED") return { key: "auth.sessionExpired" };
  if (code && SHOWN_CODES.has(code) && typeof err === "object" && err !== null && "message" in err) {
    const message = err.message;
    if (typeof message === "string" && message.trim() && message.length <= 300) return { text: message };
  }
  return { key: "support.error.generic" };
}

export function checkoutErrorMessage(err: unknown): string {
  const view = checkoutErrorText(err);
  return "text" in view ? view.text : t(view.key);
}

/** Catalog text for a code-to-key result (components never call `t` with a variable). */
export function supportText(key: MessageKey, vars?: Record<string, string | number>): string {
  return t(key, vars);
}

// ---- subscriptions ----

export const SUBSCRIPTION_STATUS_VIEW: Record<SubscriptionStatus, { key: MessageKey; tone: StatusTone }> = {
  incomplete: { key: "support.status.incomplete", tone: "info" },
  active: { key: "support.status.active", tone: "success" },
  past_due: { key: "support.status.past_due", tone: "warning" },
  canceled: { key: "support.status.canceled", tone: "neutral" },
  expired: { key: "support.status.expired", tone: "neutral" },
};

/** Cancel at period end: active rows that are not already cancelling (spec, /settings/subscriptions). */
export function canCancel(subscription: SubscriptionDto): boolean {
  return subscription.status === "active" && !subscription.cancelAtPeriodEnd;
}

/** The period-end label: "Ends" when it will not renew (cancelling, gifted, ended), else "Renews". */
export function periodEndKey(subscription: SubscriptionDto): MessageKey {
  return subscription.cancelAtPeriodEnd || subscription.gifted || !HOLDING.includes(subscription.status)
    ? "subscriptions.ends"
    : "subscriptions.renews";
}

/** Current subscriptions first (active, renewal due, awaiting payment), then ended ones; newest first within. */
export function sortSubscriptions(list: readonly SubscriptionDto[]): SubscriptionDto[] {
  const rank: Record<SubscriptionStatus, number> = { active: 0, past_due: 1, incomplete: 2, canceled: 3, expired: 4 };
  return [...list].sort((a, b) => rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt));
}
