// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The advisory jury's pure rules on the API side (ADR 0038): settings, who may sit, per-case
 * conflicts and how results are published. Unit-tested in `tests/jury.test.ts`.
 */
import type { JuryResults } from "@commonair/contracts/dto";
import { JURY_RULES, type ModerationTier, type PLATFORM_ROLES } from "@commonair/contracts/enums";
import { JuryCasesPerPanelSetting, JuryEnabledSetting, JuryPanelSizeSetting } from "@commonair/contracts/shapes";
import { partsOf } from "../transparency/enforcement.ts";

type Count = JuryResults["rows"][number]["agree"];

export const JURY_SETTING_KEYS = ["jury.enabled", "jury.panelSize", "jury.casesPerPanel"] as const;

export interface JurySettings {
  enabled: boolean;
  panelSize: number;
  casesPerPanel: number;
}

/** A missing or malformed row reads as off with the `JURY_RULES` defaults. */
export function parseJurySettings(rows: readonly { key: string; value: unknown }[]): JurySettings {
  const value = (key: string) => rows.find((r) => r.key === key)?.value;
  const enabled = JuryEnabledSetting.safeParse(value("jury.enabled"));
  const size = JuryPanelSizeSetting.safeParse(value("jury.panelSize"));
  const cases = JuryCasesPerPanelSetting.safeParse(value("jury.casesPerPanel"));
  return {
    enabled: enabled.success ? enabled.data.enabled : false,
    panelSize: size.success ? size.data.panelSize : JURY_RULES.panelSize,
    casesPerPanel: cases.success ? cases.data.casesPerPanel : JURY_RULES.casesPerPanel,
  };
}

/** Why a caller may not sit (ADR 0038 §3), or null when they may. */
type PlatformRole = (typeof PLATFORM_ROLES)[number];

export type Ineligibility = "staff" | "not_member" | "not_adult" | "suspended" | "bot";

export function ineligibility(u: {
  role: PlatformRole;
  accountType: "human" | "bot";
  suspended: boolean;
  activeMember: boolean;
  adult: boolean;
}): Ineligibility | null {
  if (u.accountType !== "human") return "bot";
  if (u.role !== "user") return "staff";
  if (u.suspended) return "suspended";
  if (!u.activeMember) return "not_member";
  if (!u.adult) return "not_adult";
  return null;
}

/** Who is involved in a sampled case, for a juror's conflicts. */
export interface CaseInvolvement {
  channelId: string | null;
  /** Subject user, channel owner, reporter, and whoever decided or handled it. */
  partyIds: readonly (string | null)[];
}

/**
 * A juror who moderates the case's channel, or who is a party to it, is not shown the case and
 * may not vote on it. They keep their seat (ADR 0038 §3).
 */
export function isConflicted(jurorId: string, c: CaseInvolvement, moderatedChannelIds: ReadonlySet<string>): boolean {
  if (c.partyIds.includes(jurorId)) return true;
  return c.channelId !== null && moderatedChannelIds.has(c.channelId);
}

export interface VoteTally {
  agree: number;
  disagree: number;
  unsure: number;
}

/**
 * One published row's cells (ADR 0038 §7, k = `JURY_RULES.k`): a clause and tier with fewer than
 * k votes in all is suppressed whole; otherwise each count goes through the transparency
 * report's rules (`partsOf`: 1..k−1 hidden, zero shown, and when exactly one part is hidden the
 * smallest visible one is hidden too, so the parts never give it away).
 */
export function publishTally(t: VoteTally): { agree: Count; disagree: Count; unsure: Count } {
  const total = t.agree + t.disagree + t.unsure;
  if (total < JURY_RULES.k) {
    const hidden: Count = { suppressed: true };
    return { agree: hidden, disagree: hidden, unsure: hidden };
  }
  const [agree, disagree, unsure] = partsOf([t.agree, t.disagree, t.unsure]) as [Count, Count, Count];
  return { agree, disagree, unsure };
}

export interface ResultVote {
  clauseId: string;
  clauseVersion: number;
  tier: ModerationTier | null;
  vote: "agree" | "disagree" | "unsure";
}

/** Votes grouped by clause and tier, each with the highest clause version seen (for its title). */
export function tallyByClause(
  votes: readonly ResultVote[],
): { clauseId: string; clauseVersion: number; tier: ModerationTier | null; tally: VoteTally }[] {
  const rows = new Map<
    string,
    { clauseId: string; clauseVersion: number; tier: ModerationTier | null; tally: VoteTally }
  >();
  for (const v of votes) {
    const key = `${v.clauseId}|${v.tier ?? ""}`;
    const row = rows.get(key) ?? {
      clauseId: v.clauseId,
      clauseVersion: v.clauseVersion,
      tier: v.tier,
      tally: { agree: 0, disagree: 0, unsure: 0 },
    };
    row.clauseVersion = Math.max(row.clauseVersion, v.clauseVersion);
    row.tally[v.vote]++;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => a.clauseId.localeCompare(b.clauseId) || (a.tier ?? "").localeCompare(b.tier ?? ""),
  );
}

/** Panels last 14 days from the draw (ADR 0038 decision 8). */
export const PANEL_MS = 14 * 86_400_000;
