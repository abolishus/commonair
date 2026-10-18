// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * TypeScript mirror of `commonair_governance_tally` (migrations 0001 + 0002). The
 * database stays authoritative: it re-tallies on every passed/rejected transition and
 * every settings application. This mirror exists for previews, the transparency page
 * and the `tallies` table, and an integration test proves it agrees with the SQL on
 * randomized electorates. Rule order and reason strings are identical to the SQL:
 *
 *   1. member-wide quorum:     eligible > 0 AND (yes+no+abstain)/eligible >= quorum
 *   2. member-wide threshold:  yes+no > 0  AND yes/(yes+no) >= memberWideThreshold
 *   3. (protected) streamer-class quorum:   s_eligible > 0 AND s_turnout/s_eligible >= streamerClassQuorum
 *   4. (protected) streamer-class majority: s_yes+s_no > 0 AND s_yes/(s_yes+s_no) > streamerClassThreshold
 *
 * Ratios use the exact Postgres numeric semantics (see numeric.ts).
 */
import { MEMBER_CLASSES, type VOTE_CHOICES } from "@commonair/contracts/enums";
import type { GovernanceRuleSnapshot, TallyBreakdown, TallyCount } from "@commonair/contracts/shapes";
import { decimalOf, formatDecimal, pgDivide, ratioAtMost, ratioBelow } from "./numeric.ts";

export type MemberClass = (typeof MEMBER_CLASSES)[number];
export type VoteChoice = (typeof VOTE_CHOICES)[number];

/** One row of `proposal_electorate`. */
export interface ElectorateMember {
  userId: string;
  classes: readonly MemberClass[];
}

/** One row of `votes`. */
export interface Ballot {
  userId: string;
  choice: VoteChoice;
  castAt?: Date;
}

export const TALLY_REASONS = [
  "passed",
  "proposal not found",
  "voting never opened",
  "malformed rules",
  "voting has not ended",
  "member-wide quorum not met",
  "member-wide threshold not met",
  "streamer-class quorum not met",
  "streamer-class majority not met",
] as const;
export type TallyReason = (typeof TALLY_REASONS)[number];

export const TALLY_RULES = [
  "member_wide_quorum",
  "member_wide_threshold",
  "streamer_class_quorum",
  "streamer_class_majority",
] as const;

export interface TallyOptions {
  /**
   * The proposal's `votingEndsAt`. When given, votes cast after it are ignored (as in SQL),
   * `null` yields "voting never opened", and a time after `now` yields "voting has not ended".
   * Omit it for a live preview of an open vote.
   */
  votingEndsAt?: Date | null;
  now?: Date;
}

export interface TallyResult {
  passed: boolean;
  reason: TallyReason;
  breakdown: TallyBreakdown;
}

/** `commonair_rules_wellformed`: the frozen snapshot must carry typed values. */
export function rulesWellFormed(rules: unknown): rules is GovernanceRuleSnapshot {
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) return false;
  const r = rules as Record<string, unknown>;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    typeof r.protected === "boolean" &&
    typeof r.councilReviewRequired === "boolean" &&
    finite(r.memberWideThreshold) &&
    finite(r.streamerClassThreshold) &&
    finite(r.quorum) &&
    finite(r.streamerClassQuorum)
  );
}

const emptyCount = (): TallyCount => ({ eligible: 0, yes: 0, no: 0, abstain: 0 });

/** Counts per class and member-wide, joining votes to the electorate like the SQL does. */
export function countVotes(
  electorate: readonly ElectorateMember[],
  votes: readonly Ballot[],
  votingEndsAt?: Date | null,
): Pick<TallyBreakdown, "memberWide" | "byClass"> {
  const members = new Map<string, ElectorateMember>();
  for (const m of electorate) if (!members.has(m.userId)) members.set(m.userId, m);

  // One vote per member (the database has a unique index); the latest cast wins.
  const latest = new Map<string, Ballot>();
  for (const v of votes) {
    if (!members.has(v.userId)) continue;
    if (votingEndsAt && v.castAt && v.castAt.getTime() > votingEndsAt.getTime()) continue;
    const prev = latest.get(v.userId);
    if (!prev || (v.castAt?.getTime() ?? 0) >= (prev.castAt?.getTime() ?? 0)) latest.set(v.userId, v);
  }

  const memberWide = emptyCount();
  const byClass = Object.fromEntries(MEMBER_CLASSES.map((c) => [c, emptyCount()])) as Record<MemberClass, TallyCount>;
  for (const m of members.values()) {
    const classes = new Set(m.classes);
    memberWide.eligible++;
    for (const c of classes) byClass[c].eligible++;
    const v = latest.get(m.userId);
    if (!v) continue;
    memberWide[v.choice]++;
    for (const c of classes) byClass[c][v.choice]++;
  }
  return { memberWide, byClass };
}

const pct = (num: number, den: number) => (den === 0 ? "n/a" : `${formatDecimal(pgDivide(num * 100, den), 2)}%`);
const pctOf = (t: number) => `${formatDecimal(decimalOf(Math.max(t, 0) * 100), 2)}%`;

type Check = TallyBreakdown["checks"][number];

function evaluate(rules: GovernanceRuleSnapshot, counts: Pick<TallyBreakdown, "memberWide" | "byClass">): Check[] {
  const { memberWide: m } = counts;
  const s = counts.byClass.streamer;
  const turnout = m.yes + m.no + m.abstain;
  const sTurnout = s.yes + s.no + s.abstain;
  const checks: Check[] = [
    {
      rule: "member_wide_quorum",
      passed: m.eligible > 0 && !ratioBelow(turnout, m.eligible, rules.quorum),
      detail: `turnout ${turnout}/${m.eligible} (${pct(turnout, m.eligible)}), at least ${pctOf(rules.quorum)} required`,
    },
    {
      rule: "member_wide_threshold",
      passed: m.yes + m.no > 0 && !ratioBelow(m.yes, m.yes + m.no, rules.memberWideThreshold),
      detail: `yes ${m.yes}/${m.yes + m.no} of yes+no (${pct(m.yes, m.yes + m.no)}), at least ${pctOf(rules.memberWideThreshold)} required`,
    },
  ];
  if (rules.protected) {
    checks.push(
      {
        rule: "streamer_class_quorum",
        passed: s.eligible > 0 && !ratioBelow(sTurnout, s.eligible, rules.streamerClassQuorum),
        detail: `streamer turnout ${sTurnout}/${s.eligible} (${pct(sTurnout, s.eligible)}), at least ${pctOf(rules.streamerClassQuorum)} required`,
      },
      {
        rule: "streamer_class_majority",
        passed: s.yes + s.no > 0 && !ratioAtMost(s.yes, s.yes + s.no, rules.streamerClassThreshold),
        detail: `streamer yes ${s.yes}/${s.yes + s.no} of yes+no (${pct(s.yes, s.yes + s.no)}), more than ${pctOf(rules.streamerClassThreshold)} required`,
      },
    );
  }
  return checks;
}

const FAIL_REASON: Record<(typeof TALLY_RULES)[number], TallyReason> = {
  member_wide_quorum: "member-wide quorum not met",
  member_wide_threshold: "member-wide threshold not met",
  streamer_class_quorum: "streamer-class quorum not met",
  streamer_class_majority: "streamer-class majority not met",
};

/**
 * Tally a proposal. Every applicable check is evaluated and reported in `breakdown.checks`
 * (for transparency); `reason` is the first failing one in SQL order.
 */
export function tally(
  rules: unknown,
  electorate: readonly ElectorateMember[],
  votes: readonly Ballot[],
  opts: TallyOptions = {},
): TallyResult {
  const counts = countVotes(electorate, votes, opts.votingEndsAt);
  const fail = (reason: TallyReason): TallyResult => ({ passed: false, reason, breakdown: { ...counts, checks: [] } });

  if (opts.votingEndsAt === null) return fail("voting never opened");
  if (!rulesWellFormed(rules)) return fail("malformed rules");
  if (opts.votingEndsAt && opts.votingEndsAt.getTime() > (opts.now ?? new Date()).getTime()) {
    return fail("voting has not ended");
  }

  const checks = evaluate(rules, counts);
  const failed = checks.find((c) => !c.passed);
  return {
    passed: !failed,
    reason: failed ? FAIL_REASON[failed.rule as (typeof TALLY_RULES)[number]] : "passed",
    breakdown: { ...counts, checks },
  };
}
