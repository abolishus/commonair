// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed-out actions the sign-up prompt stands in for (README D2.1, voice-copy §4.6), and how
 * each maps to `?intent=` on sign-up. Pure, so the mapping and the links are unit-tested.
 */
import { SIGNUP_INTENTS, type SignupIntent } from "@commonair/contracts/enums";
import { Slug } from "@commonair/contracts";

/** Every action that can open `<AuthGatePrompt>`. `vote` and `report` are prompt-only. */
export const GATE_INTENTS = [
  "follow",
  "chat",
  "support",
  "predict",
  "clip",
  "watch",
  "stream",
  "import",
  "join",
  "vote",
  "report",
] as const;
export type GateIntent = (typeof GATE_INTENTS)[number];

/** Intents whose prompt and sign-up headline name a channel. */
export const CHANNEL_INTENTS: ReadonlySet<SignupIntent> = new Set(["follow", "chat", "support", "watch"]);

/**
 * Intents that end in an action on the page the visitor came from, so they come back to a
 * one-tap confirm there. The others (stream, import, join) land on their own pages instead.
 */
export const CONFIRMABLE_INTENTS: ReadonlySet<SignupIntent> = new Set([
  "follow",
  "chat",
  "support",
  "predict",
  "clip",
  "watch",
]);

/**
 * `?intent=` for a gate or a link: `vote` counts as `join` and `report` as `none` (no enum change,
 * voice-copy §4.6); anything else that is not a sign-up intent is dropped.
 */
export function signupIntentOf(value: unknown): SignupIntent | undefined {
  if (value === "vote") return "join";
  if (value === "report") return "none";
  return typeof value === "string" && (SIGNUP_INTENTS as readonly string[]).includes(value)
    ? (value as SignupIntent)
    : undefined;
}

/** A channel slug from a link, or undefined. */
export function channelSlugOf(value: unknown): string | undefined {
  return typeof value === "string" && Slug.safeParse(value).success ? value : undefined;
}

/** Where an intent with no page to return to lands after verification (README D2.1, the mockups). */
export function intentLanding(intent: SignupIntent | undefined): string | undefined {
  switch (intent) {
    case "stream":
      return "/dashboard";
    case "import":
      return "/import";
    case "join":
      return "/coop/membership";
    default:
      return undefined;
  }
}

export interface GateSearch {
  redirect?: string;
  intent?: SignupIntent;
  channel?: string;
}

/** The search both prompt buttons carry: this page, the intent and (when known) the channel. */
export function gateSearch(intent: GateIntent, redirect: string | undefined, channel?: string): GateSearch {
  const out: GateSearch = {};
  if (redirect !== undefined) out.redirect = redirect;
  const mapped = signupIntentOf(intent);
  if (mapped !== undefined && mapped !== "none") out.intent = mapped;
  const slug = channelSlugOf(channel);
  if (slug !== undefined) out.channel = slug;
  return out;
}

/** Report is the one gate where Sign in leads: reports come from accounts that already exist. */
export const signInLeads = (intent: GateIntent): boolean => intent === "report";
