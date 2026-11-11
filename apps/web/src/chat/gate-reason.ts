// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Why a viewer cannot chat yet, worked out before they type (ux-journeys J3-d): the channel's
 * settings (the `joined` and `settings` frames) against what the page knows about the viewer, plus
 * the last refusal the server sent. The server still decides (`services/chat/src/rules.ts`); this
 * only says it first, in the same order the server checks. The verified-watch gate is not here:
 * `SurgeBanner` says that one, and never how close the viewer is (ADR 0015 decision 4).
 */
import type { ChannelChatSettings } from "@commonair/contracts/shapes";

const DAY_MS = 86_400_000;

/** What the page knows about the signed-in viewer; anything unknown is left out. */
export interface GateFacts {
  emailVerified?: boolean;
  /** The account's creation time (ISO 8601). */
  accountCreatedAt?: string;
  /** Whether they follow the channel; null or absent when unknown. */
  following?: boolean | null;
}

/** Refusal notice codes that name a gate the composer can explain. */
export const GATE_REFUSALS = [
  "msg_verified_email",
  "msg_account_too_new",
  "msg_followersonly",
  "msg_subsonly",
] as const;
export type GateRefusal = (typeof GATE_REFUSALS)[number];

export function isGateRefusal(code: string): code is GateRefusal {
  return (GATE_REFUSALS as readonly string[]).includes(code);
}

export type GateReason =
  | { kind: "verifiedEmail" }
  /** `opensAt`: when the account is old enough (ISO 8601); null when the server refused but the age is unknown. */
  | { kind: "accountAge"; days: number; opensAt: string | null }
  | { kind: "followers"; minutes: number }
  | { kind: "subs" };

export interface GateInput {
  settings: ChannelChatSettings | null;
  facts: GateFacts;
  /** The last gate refusal since the (re)join, if any. */
  refused: GateRefusal | null;
  /** Moderators and the broadcaster skip every chat mode. */
  privileged: boolean;
  now: number;
}

/** The first gate that stops this viewer, or null when nothing is known to stop them. */
export function composerGate({ settings, facts, refused, privileged, now }: GateInput): GateReason | null {
  if (!settings || privileged) return null;
  if (settings.requireVerifiedEmail && (facts.emailVerified === false || refused === "msg_verified_email"))
    return { kind: "verifiedEmail" };
  if (settings.minAccountAgeDays > 0) {
    const created = facts.accountCreatedAt === undefined ? Number.NaN : Date.parse(facts.accountCreatedAt);
    const opens = created + settings.minAccountAgeDays * DAY_MS;
    if (Number.isFinite(opens) && opens > now)
      return { kind: "accountAge", days: settings.minAccountAgeDays, opensAt: new Date(opens).toISOString() };
    if (refused === "msg_account_too_new" && !Number.isFinite(opens))
      return { kind: "accountAge", days: settings.minAccountAgeDays, opensAt: null };
  }
  const minutes = settings.followersOnlyMinutes;
  // A refusal stands until the viewer follows or sends again (the panel clears it on each send).
  const followedSince = refused === "msg_followersonly" && !(minutes === 0 && facts.following === true);
  if (minutes !== null && (facts.following === false || followedSince)) return { kind: "followers", minutes };
  if (settings.subscribersOnly && refused === "msg_subsonly") return { kind: "subs" };
  return null;
}

/** Whether the viewer's own account facts are worth fetching for these settings. */
export function needsAccountFacts(settings: ChannelChatSettings | null, privileged: boolean): boolean {
  return settings !== null && !privileged && (settings.requireVerifiedEmail || settings.minAccountAgeDays > 0);
}
