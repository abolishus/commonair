// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Intent-aware sign-up copy (README D2.2, voice-copy §4.5): the headline, the perks, the after-note. */
import type { SignupIntent } from "@commonair/contracts/enums";
import { SITE } from "@commonair/config/site";
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

/** What the account gives, for the intent: the creator intents talk about the channel. */
export function signupPerks(intent: SignupIntent | undefined): MessageKey[] {
  switch (intent) {
    case "stream":
      return ["d2Gate.signup.perk.channelAddress", "d2Gate.signup.perk.deleteAnyTime"];
    case "import":
      return ["d2Gate.signup.perk.channelAddress", "d2Gate.signup.perk.importReadOnly"];
    case "join":
      return ["d2Gate.signup.perk.vote", "d2Gate.signup.perk.share"];
    default:
      return ["d2Gate.signup.perk.follow", "d2Gate.signup.perk.chat", "d2Gate.signup.perk.vote"];
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
