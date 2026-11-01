// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Giveaway helpers for the studio panel, the chat card and the public verify page (ADR 0039
 * §1–§2): the open form's checks, the refusal messages, and the in-browser re-run of the draw with
 * `@commonair/draw` (the same code the server ran).
 */
import { GIVEAWAY_RULES } from "@commonair/contracts/enums";
import type { Giveaway, GiveawayVerification } from "@commonair/contracts/dto";
import { draw, isSortedUnique, verifyReveal } from "@commonair/draw";
import type { MessageKey } from "../../i18n/index.ts";
import { errorCode } from "../../lib/api.ts";
import { errorReason } from "../../lib/coop.ts";
import { parseBoundedInt } from "../../lib/interact-studio.ts";

export type GiveawayDto = Giveaway;
export type GiveawayVerificationDto = GiveawayVerification;
export type IneligibleReason = NonNullable<NonNullable<Giveaway["me"]>["reason"]>;

/** `interact.giveaways.open` bounds (the contract's). */
export const GIVEAWAY_LIMITS = {
  titleMax: 60,
  prizeMax: 200,
  maxWinners: GIVEAWAY_RULES.maxWinners,
  maxDurationMinutes: GIVEAWAY_RULES.maxDurationMinutes,
  maxDays: 3650,
  maxWatchSeconds: 14_400,
} as const;
const KEYWORD = /^!?[A-Za-z0-9]{2,20}$/;

export interface GiveawayDraft {
  title: string;
  prize: string;
  winnerCount: string;
  /** Empty = button entry only. */
  keyword: string;
  /** Minutes; empty = no timed close. */
  duration: string;
  minAccountAgeDays: string;
  /** Empty = following not required; 0 = following required. */
  minFollowDays: string;
  minWatchSeconds: string;
}

export type GiveawayField = keyof GiveawayDraft;
export type GiveawayFieldErrors = Partial<Record<GiveawayField, MessageKey>>;

export const emptyGiveawayDraft = (): GiveawayDraft => ({
  title: "",
  prize: "",
  winnerCount: "1",
  keyword: "",
  duration: "",
  minAccountAgeDays: "0",
  minFollowDays: "",
  minWatchSeconds: "0",
});

export interface GiveawayOpenInput {
  channel: string;
  title: string;
  prize: string;
  winnerCount: number;
  keyword: string | null;
  durationMinutes: number | null;
  eligibility: { minAccountAgeDays: number; minFollowDays: number | null; minVerifiedWatchSeconds: number };
}

/** The form's checks, before the server's: field → message key. */
export function giveawayInput(
  channel: string,
  d: GiveawayDraft,
): { ok: true; input: GiveawayOpenInput } | { ok: false; errors: GiveawayFieldErrors } {
  const errors: GiveawayFieldErrors = {};
  const title = d.title.trim();
  const prize = d.prize.trim();
  if (title.length === 0 || title.length > GIVEAWAY_LIMITS.titleMax) errors.title = "giveaways.form.error.title";
  if (prize.length === 0 || prize.length > GIVEAWAY_LIMITS.prizeMax) errors.prize = "giveaways.form.error.prize";
  const winnerCount = parseBoundedInt(d.winnerCount, 1, GIVEAWAY_LIMITS.maxWinners);
  if (winnerCount === null) errors.winnerCount = "giveaways.form.error.winnerCount";
  const keyword = d.keyword.trim();
  if (keyword !== "" && !KEYWORD.test(keyword)) errors.keyword = "giveaways.form.error.keyword";
  const duration = d.duration.trim() === "" ? null : parseBoundedInt(d.duration, 1, GIVEAWAY_LIMITS.maxDurationMinutes);
  if (d.duration.trim() !== "" && duration === null) errors.duration = "giveaways.form.error.duration";
  const age = parseBoundedInt(d.minAccountAgeDays, 0, GIVEAWAY_LIMITS.maxDays);
  if (age === null) errors.minAccountAgeDays = "giveaways.form.error.days";
  const follow = d.minFollowDays.trim() === "" ? null : parseBoundedInt(d.minFollowDays, 0, GIVEAWAY_LIMITS.maxDays);
  if (d.minFollowDays.trim() !== "" && follow === null) errors.minFollowDays = "giveaways.form.error.days";
  const watch = parseBoundedInt(d.minWatchSeconds, 0, GIVEAWAY_LIMITS.maxWatchSeconds);
  if (watch === null) errors.minWatchSeconds = "giveaways.form.error.watch";
  if (Object.keys(errors).length > 0 || winnerCount === null || age === null || watch === null)
    return { ok: false, errors };
  return {
    ok: true,
    input: {
      channel,
      title,
      prize,
      winnerCount,
      keyword: keyword === "" ? null : keyword,
      durationMinutes: duration,
      eligibility: { minAccountAgeDays: age, minFollowDays: follow, minVerifiedWatchSeconds: watch },
    },
  };
}

/** Why the viewer cannot enter, as the card says it. */
export const INELIGIBLE_KEYS: Record<IneligibleReason, MessageKey> = {
  account_age: "giveaways.card.reason.accountAge",
  follow_age: "giveaways.card.reason.followAge",
  not_following: "giveaways.card.reason.notFollowing",
  verified_watch: "giveaways.card.reason.verifiedWatch",
  banned: "giveaways.card.reason.banned",
};

const isReason = (r: string | null): r is IneligibleReason => r !== null && r in INELIGIBLE_KEYS;

/** A refused entry as the viewer's message (never the server's English text). */
export function enterErrorKey(err: unknown): MessageKey {
  const reason = errorReason(err);
  if (reason === "giveaways_disabled") return "giveaways.card.error.disabled";
  if (isReason(reason)) return INELIGIBLE_KEYS[reason];
  switch (errorCode(err)) {
    case "UNAUTHORIZED":
      return "giveaways.card.signIn";
    case "CONFLICT":
      return reason === "already_entered" ? "giveaways.card.entered" : "giveaways.card.error.closed";
    case "TOO_MANY_REQUESTS":
    case "RATE_LIMITED":
      return "giveaways.card.error.slowDown";
    default:
      return "giveaways.card.error.failed";
  }
}

export const STATUS_KEYS: Record<Giveaway["status"], MessageKey> = {
  open: "giveaways.status.open",
  closed: "giveaways.status.closed",
  drawn: "giveaways.status.drawn",
  cancelled: "giveaways.status.cancelled",
};

// ------------------------------------------------------------------ the public re-run

export type VerifyOutcome =
  | { state: "pending" }
  | { state: "cancelled" }
  | { state: "checked"; match: boolean; problem: "commitment" | "entries" | "winners" | null; skipped: number };

/**
 * Does the published result follow from the revealed seed? Mirrors `winnersMatchDraw` in
 * `@commonair/interact` (which the web does not depend on): ranks run 1…k with k at most the
 * winner count, and the winners by rank are the draw's permutation in order with only passed-over
 * (ineligible at draw time) entries between them.
 */
export function winnersFollowDraw(
  order: readonly number[],
  winners: readonly { rank: number; index: number }[],
  winnerCount: number,
): { match: boolean; skipped: number } {
  const byRank = [...winners].sort((a, b) => a.rank - b.rank);
  if (byRank.length > winnerCount || byRank.some((w, i) => w.rank !== i + 1)) return { match: false, skipped: 0 };
  let pos = 0;
  let skipped = 0;
  for (const w of byRank) {
    while (pos < order.length && order[pos] !== w.index) {
      pos++;
      skipped++;
    }
    if (pos >= order.length) return { match: false, skipped };
    pos++;
  }
  if (byRank.length < winnerCount) skipped = order.length - byRank.length;
  return { match: true, skipped };
}

/**
 * As much of the draw as the check needs: up to the last published winner (`draw(k)` is a prefix of
 * `draw(k + 1)`, so a longer prefix never changes the answer), growing geometrically, which is one
 * HMAC per drawn index rather than per entrant. With fewer winners than places every entry was
 * passed over or won, so the whole permutation is needed.
 */
async function drawnPrefix(seed: string, v: GiveawayVerificationDto): Promise<number[]> {
  const n = v.entries.length;
  if (v.winners.length < v.winnerCount) return draw(seed, v.entries, n);
  let count = Math.min(n, v.winnerCount);
  for (;;) {
    const order = await draw(seed, v.entries, count);
    const drawn = new Set(order);
    if (count >= n || v.winners.every((w) => drawn.has(w.index))) return order;
    count = Math.min(n, count * 2);
  }
}

/** Re-run the draw in the browser: commitment, sorted entries, then winners. */
export async function verifyDraw(v: GiveawayVerificationDto): Promise<VerifyOutcome> {
  if (v.status === "cancelled") return { state: "cancelled" };
  if (v.seed === null) return { state: "pending" };
  if (!(await verifyReveal(v.seed, v.seedCommitment)))
    return { state: "checked", match: false, problem: "commitment", skipped: 0 };
  if (!isSortedUnique(v.entries)) return { state: "checked", match: false, problem: "entries", skipped: 0 };
  const order = await drawnPrefix(v.seed, v);
  const named = v.winners.every((w) => v.entries[w.index] === w.pseudonym);
  const r = winnersFollowDraw(order, v.winners, v.winnerCount);
  const match = named && r.match;
  return { state: "checked", match, problem: match ? null : "winners", skipped: r.skipped };
}
