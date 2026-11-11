// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio co-op card's facts (overhaul wave 4, D6.4; coop-trust P6 "Studio"), pure so every
 * edge is unit tested: the streamer membership's status, the progress toward the streamer class's
 * hours rule (`coop.membership` eligibility, the window from `membership.classes`) and the
 * caller's creator council rank, if any.
 */
import type { CouncilDto, MembershipViewDto } from "../../lib/coop.ts";
import type { SettingLike } from "../creators/facts.ts";
import { coopFacts } from "../creators/facts.ts";

/** `member`: an active streamer membership (a member-owner); `lapsed`: one that lapsed; else `notYet`. */
export type CoopCardStatus = "member" | "lapsed" | "notYet";

export interface StreamerProgress {
  /** Eligible streaming hours in the window (may be fractional). */
  have: number;
  need: number;
  /** Whole percent toward `need`, 0–100 (100 with no hours needed). */
  percent: number;
  /** The rule's window, or null when `membership.classes` did not read. */
  windowDays: number | null;
}

export interface CoopCardFacts {
  status: CoopCardStatus;
  progress: StreamerProgress | null;
  /** The caller's rank on the current creator council, or null when not on it. */
  councilRank: number | null;
}

export function coopCardStatus(view: Pick<MembershipViewDto, "memberships">): CoopCardStatus {
  const streamer = view.memberships.filter((m) => m.class === "streamer");
  if (streamer.some((m) => m.status === "active")) return "member";
  if (streamer.some((m) => m.status === "lapsed")) return "lapsed";
  return "notYet";
}

export function streamerProgress(
  view: Pick<MembershipViewDto, "eligibility">,
  settings: readonly SettingLike[] | null,
): StreamerProgress | null {
  const p = view.eligibility.find((e) => e.class === "streamer")?.progress;
  if (!p || p.unit !== "hours") return null;
  const have = Math.max(0, p.have);
  const need = Math.max(0, p.need);
  const percent = need === 0 ? 100 : Math.min(100, Math.floor((have / need) * 100));
  return { have, need, percent, windowDays: coopFacts(settings).membership?.windowDays ?? null };
}

export function councilRank(council: Pick<CouncilDto, "members"> | null, userId: string): number | null {
  return council?.members.find((m) => m.user.id === userId)?.rank ?? null;
}

export function coopCardFacts(
  view: MembershipViewDto,
  council: CouncilDto | null,
  settings: readonly SettingLike[] | null,
  userId: string,
): CoopCardFacts {
  return {
    status: coopCardStatus(view),
    progress: streamerProgress(view, settings),
    councilRank: councilRank(council, userId),
  };
}
