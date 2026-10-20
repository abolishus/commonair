// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Platform events (`op: "event"` frames) shown inline in the chat log: new subscriptions, gift
 * subs and tips. The payload is validated against the event catalog in @commonair/contracts;
 * anything else (unknown types, malformed data) is dropped. Pure, for unit tests.
 */
import { EVENTS } from "@commonair/contracts/events";
import { t } from "../i18n/index.ts";

export const CHAT_EVENT_TYPES = ["channel.subscribe", "channel.subscription.gift", "channel.tip"] as const;
export type ChatEventType = (typeof CHAT_EVENT_TYPES)[number];

export interface ChatEventView {
  type: ChatEventType;
  /** The login the event is about, "" when anonymous (`data-user`). */
  user: string;
  /** Display name; null when anonymous. */
  name: string | null;
  tier: number | null;
  /** Tips: the amount in minor units and its currency. */
  amount: { cents: number; currency: string } | null;
  /** Gift subs: how many were gifted (`data-total`). */
  total: number | null;
  isGift: boolean;
  message: string | null;
}

/** EventSub tier strings ("1000" | "2000" | "3000") → 1–3. */
function tierNumber(tier: "1000" | "2000" | "3000"): number {
  return Number.parseInt(tier, 10) / 1000;
}

export function chatEventView(type: string, data: unknown): ChatEventView | null {
  switch (type) {
    case "channel.subscribe": {
      const p = EVENTS[type].payload.safeParse(data);
      if (!p.success) return null;
      return {
        type,
        user: p.data.user_login,
        name: p.data.user_name || p.data.user_login,
        tier: tierNumber(p.data.tier),
        amount: null,
        total: null,
        isGift: p.data.is_gift,
        message: null,
      };
    }
    case "channel.subscription.gift": {
      const p = EVENTS[type].payload.safeParse(data);
      if (!p.success) return null;
      const anonymous = p.data.is_anonymous || !p.data.user_login;
      return {
        type,
        user: anonymous ? "" : (p.data.user_login ?? ""),
        name: anonymous ? null : p.data.user_name || p.data.user_login,
        tier: tierNumber(p.data.tier),
        amount: null,
        total: p.data.total,
        isGift: true,
        message: null,
      };
    }
    case "channel.tip": {
      const p = EVENTS[type].payload.safeParse(data);
      if (!p.success) return null;
      const anonymous = p.data.is_anonymous || !p.data.user_login;
      return {
        type,
        user: anonymous ? "" : (p.data.user_login ?? ""),
        name: anonymous ? null : p.data.user_name || p.data.user_login,
        tier: null,
        // `decimal_places` is fixed at 2 in the catalog, so `value` is already in cents.
        amount: { cents: p.data.amount.value, currency: p.data.amount.currency },
        total: null,
        isGift: false,
        message: p.data.message.trim() || null,
      };
    }
    default:
      return null;
  }
}

/** The event's one line in the viewer's language. */
export function chatEventText(view: ChatEventView): string {
  const vars = { name: view.name ?? "", tier: view.tier ?? "", total: view.total ?? "" };
  if (view.type === "channel.subscribe")
    return view.isGift ? t("chat.event.subscribeGift", vars) : t("chat.event.subscribe", vars);
  if (view.type === "channel.subscription.gift") {
    if (view.total === 1) return view.name ? t("chat.event.giftOne", vars) : t("chat.event.giftAnonymousOne", vars);
    return view.name ? t("chat.event.giftOther", vars) : t("chat.event.giftAnonymousOther", vars);
  }
  return view.name ? t("chat.event.tip", vars) : t("chat.event.tipAnonymous");
}
