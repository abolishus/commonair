// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Intent-aware sign-up copy (README D2.2, voice-copy §4.5): the headline, the perks, the after-note. */
import type { SignupIntent } from "@commonair/contracts/enums";
import { SITE } from "@commonair/config/site";
import { formatMoney } from "@commonair/ui";
import { z } from "zod";
import { t, type MessageKey } from "../../i18n/index.ts";
import { CHANNEL_INTENTS } from "./intents.ts";

const TITLES: Record<SignupIntent, MessageKey> = {
  none: "signup.title",
  follow: "d2Gate.signup.title.follow",
  chat: "d2Gate.signup.title.chat",
  support: "d2Gate.signup.title.support",
  predict: "d2Gate.signup.title.predict",
  clip: "d2Gate.signup.title.clip",
  watch: "d2Gate.signup.title.watch",
  stream: "d2Gate.signup.title.stream",
  import: "d2Gate.signup.title.import",
  join: "d2Gate.signup.title.join",
};

/**
 * The headline names the action that brought the visitor. One that names a channel falls back to
 * the plain headline when the link carries none (a stale link).
 */
export function signupTitle(intent: SignupIntent | undefined, channel: string | undefined): string {
  const key = intent ?? "none";
  if (CHANNEL_INTENTS.has(key) && !channel) return t(TITLES.none);
  return t(TITLES[key], { channel: channel ?? "", site: SITE.name });
}

/** The join terms the perk states, read from the governed settings (`coop.settings`, public). */
export interface JoinTerms {
  shareCents: number;
  minSubCents: number;
  refundableOnExit: boolean;
  currency: string;
}

const JoinSettings = z.object({
  classes: z.object({
    viewer: z.object({
      shareCents: z.number().int().min(1),
      shareRefundableOnExit: z.boolean(),
      minSubscriptionCents: z.number().int().min(0),
    }),
  }),
  payout: z.object({ currency: z.string().min(3) }),
});

/**
 * `membership.classes` (the viewer share and the minimum sub) and `payout.rules` (the instance
 * currency) → the terms; null when either is unreadable or no share is on offer, so the perk
 * states no figure rather than a stale one.
 */
export function joinTermsOf(settings: readonly { key: string; value: unknown }[] | null | undefined): JoinTerms | null {
  const by = (key: string) => settings?.find((s) => s.key === key)?.value;
  const parsed = JoinSettings.safeParse({ classes: by("membership.classes"), payout: by("payout.rules") });
  if (!parsed.success) return null;
  const { viewer } = parsed.data.classes;
  return {
    shareCents: viewer.shareCents,
    minSubCents: viewer.minSubscriptionCents,
    refundableOnExit: viewer.shareRefundableOnExit,
    currency: parsed.data.payout.currency,
  };
}

export interface Perk {
  key: MessageKey;
  values?: Record<string, string>;
}

/** The join perk: the governed figures when known, otherwise a variant with none. */
function sharePerk(terms: JoinTerms | null, locale: string): Perk {
  if (!terms) return { key: "d2Gate.signup.perk.shareNoFigure" };
  const values = {
    shareAmount: formatMoney(terms.shareCents, terms.currency, locale),
    minSub: formatMoney(terms.minSubCents, terms.currency, locale),
  };
  return { key: terms.refundableOnExit ? "d2Gate.signup.perk.share" : "d2Gate.signup.perk.shareKept", values };
}

/** What the account gives, for the intent: the creator intents talk about the channel. */
export function signupPerks(intent: SignupIntent | undefined, terms: JoinTerms | null = null, locale = "en"): Perk[] {
  switch (intent) {
    case "stream":
      return [{ key: "d2Gate.signup.perk.channelAddress" }, { key: "d2Gate.signup.perk.deleteAnyTime" }];
    case "import":
      return [{ key: "d2Gate.signup.perk.channelAddress" }, { key: "d2Gate.signup.perk.importReadOnly" }];
    case "join":
      return [{ key: "d2Gate.signup.perk.vote" }, sharePerk(terms, locale)];
    default:
      return [
        { key: "d2Gate.signup.perk.follow" },
        { key: "d2Gate.signup.perk.chat" },
        { key: "d2Gate.signup.perk.vote" },
      ];
  }
}

/** Where the verification link brings them, said before they ask (null: nowhere special). */
export function signupAfterNote(
  intent: SignupIntent | undefined,
  channel: string | undefined,
  target: string | undefined,
): string | null {
  if (channel && intent === "follow") return t("d2Gate.signup.after.follow", { channel });
  if (channel && intent === "chat") return t("d2Gate.signup.after.chat", { channel });
  if (channel && intent === "support") return t("d2Gate.signup.after.support", { channel });
  if (intent === "stream") return t("d2Gate.signup.after.stream");
  if (intent === "import") return t("d2Gate.signup.after.import");
  if (intent === "join") return t("d2Gate.signup.after.join");
  return target ? t("d2Gate.signup.after.page") : null;
}
