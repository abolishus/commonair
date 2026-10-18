// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Proposal rules mirrored from the database's proposal state machine
 * (`commonair_proposal_guard`, `commonair_rules_acceptable`). The API uses these to
 * build requests the database will accept and to explain the timeline to members;
 * the triggers still decide.
 */
import type { PROPOSAL_KINDS, PROPOSAL_STATUSES } from "@commonair/contracts/enums";
import type { GovernanceChange, GovernanceRuleSnapshot } from "@commonair/contracts/shapes";
import { decimalOf, compareDecimal } from "./numeric.ts";
import { ordinaryOf, protectionsOf, type Protections, type SettingsMap } from "./settings.ts";

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Names the SQL ruleset the snapshot is evaluated under. */
export const RULE_VERSION = "sql-0002";

/** `commonair_is_protected`: governance.protections always protects itself. */
export function isProtectedKey(key: string, protections: Pick<Protections, "protectedKeys">): boolean {
  return key === "governance.protections" || protections.protectedKeys.includes(key);
}

/**
 * The rule snapshot to freeze when voting opens: exactly the current settings for the
 * kind, which `commonair_rules_acceptable` accepts (at least as strict as current).
 * Ordinary decisions do not use the streamer-class fields; they carry neutral values
 * that satisfy the snapshot schema.
 */
export function rulesFor(
  kind: ProposalKind,
  settings: SettingsMap,
  opts: { affectsCreators?: boolean } = {},
): GovernanceRuleSnapshot {
  if (kind === "protected") {
    const p = protectionsOf(settings);
    return {
      ruleVersion: RULE_VERSION,
      protected: true,
      memberWideThreshold: p.memberWideThreshold,
      streamerClassThreshold: p.streamerClassThreshold,
      quorum: p.quorum,
      streamerClassQuorum: p.streamerClassQuorum,
      councilReviewRequired: true,
    };
  }
  const o = ordinaryOf(settings);
  return {
    ruleVersion: RULE_VERSION,
    protected: false,
    memberWideThreshold: o.threshold,
    streamerClassThreshold: 0.5,
    quorum: o.quorum,
    streamerClassQuorum: 0,
    councilReviewRequired: opts.affectsCreators ?? false,
  };
}

const atLeast = (a: number, b: number) => compareDecimal(decimalOf(Math.max(a, 0)), decimalOf(Math.max(b, 0))) >= 0;

/** `commonair_rules_acceptable`: may these rules be frozen for a proposal of this kind? */
export function rulesAcceptable(rules: GovernanceRuleSnapshot, kind: ProposalKind, settings: SettingsMap): boolean {
  if (rules.protected !== (kind === "protected")) return false;
  if (rules.memberWideThreshold > 1) return false;
  if (kind === "protected") {
    const p = protectionsOf(settings);
    return (
      rules.streamerClassThreshold < 1 &&
      rules.councilReviewRequired &&
      atLeast(rules.memberWideThreshold, p.memberWideThreshold) &&
      atLeast(rules.streamerClassThreshold, p.streamerClassThreshold) &&
      atLeast(rules.quorum, p.quorum) &&
      atLeast(rules.streamerClassQuorum, p.streamerClassQuorum)
    );
  }
  const o = ordinaryOf(settings);
  return atLeast(rules.memberWideThreshold, o.threshold) && atLeast(rules.quorum, o.quorum);
}

export type ChangeProblem =
  | { code: "unknown_key"; key: string }
  | { code: "duplicate_key"; key: string }
  | { code: "empty"; key?: undefined };

export type ChangeClassification =
  | {
      ok: true;
      /** `protected` iff any change touches a protected key (the database derives the same). */
      kind: ProposalKind;
      protectedKeys: string[];
      /** Protected proposals must affect creators (and therefore go through council review). */
      affectsCreatorsRequired: boolean;
    }
  | { ok: false; problems: ChangeProblem[] };

/** Classify a proposal's changes the way the proposal trigger will. */
export function classifyChanges(changes: readonly GovernanceChange[], settings: SettingsMap): ChangeClassification {
  const protections = protectionsOf(settings);
  const problems: ChangeProblem[] = [];
  if (changes.length === 0) problems.push({ code: "empty" });
  const seen = new Set<string>();
  for (const c of changes) {
    if (!(c.key in settings)) problems.push({ code: "unknown_key", key: c.key });
    if (seen.has(c.key)) problems.push({ code: "duplicate_key", key: c.key });
    seen.add(c.key);
  }
  if (problems.length > 0) return { ok: false, problems };
  const protectedKeys = [...seen].filter((k) => isProtectedKey(k, protections));
  const isProtected = protectedKeys.length > 0;
  return {
    ok: true,
    kind: isProtected ? "protected" : "ordinary",
    protectedKeys,
    affectsCreatorsRequired: isProtected,
  };
}

const TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  draft: ["discussion", "withdrawn"],
  discussion: ["council_review", "voting", "withdrawn"],
  council_review: ["voting", "withdrawn"],
  voting: ["passed", "rejected"],
  passed: ["applied"],
  rejected: [],
  withdrawn: [],
  applied: [],
};

/**
 * Status transitions the state machine allows from `status`. With `affectsCreators`,
 * discussion may only move on to council review (voting requires a completed review).
 */
export function allowedTransitions(status: ProposalStatus, opts: { affectsCreators?: boolean } = {}): ProposalStatus[] {
  const next = [...TRANSITIONS[status]];
  if (opts.affectsCreators === undefined) return next;
  if (status === "discussion")
    return next.filter((s) => (opts.affectsCreators ? s !== "voting" : s !== "council_review"));
  return next;
}

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Content may be edited only before review or voting begins (and never in the same update as a transition). */
export const isContentEditable = (status: ProposalStatus) => status === "draft" || status === "discussion";

/** Proposals in these states can be deleted (`only draft or withdrawn proposals can be deleted`). */
export const isDeletable = (status: ProposalStatus) => status === "draft" || status === "withdrawn";

export interface Timeline {
  discussionEndsAt: Date;
  councilReviewEndsAt: Date | null;
  /** Earliest moment voting can open. */
  votingOpensAt: Date;
  /** Earliest allowed end of the voting window if voting opens at `votingOpensAt`. */
  minVotingEndsAt: Date;
  /** The default voting window end (`governance.ordinary.votingSeconds`, never below the minimum). */
  defaultVotingEndsAt: Date;
}

const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

/**
 * Preview of the earliest timeline for a proposal entering discussion at `now`. Real
 * timestamps are set by the database with its own clock as each transition happens.
 */
export function timeline(
  settings: SettingsMap,
  now: Date,
  opts: { kind: ProposalKind; affectsCreators: boolean },
): Timeline {
  const o = ordinaryOf(settings);
  const p = protectionsOf(settings);
  const affectsCreators = opts.affectsCreators || opts.kind === "protected";
  const discussionEndsAt = plus(now, o.discussionSeconds);
  const councilReviewEndsAt = affectsCreators ? plus(discussionEndsAt, p.councilReviewSeconds) : null;
  const votingOpensAt = councilReviewEndsAt ?? discussionEndsAt;
  const minVoting = opts.kind === "protected" ? p.minVotingSeconds : o.minVotingSeconds;
  return {
    discussionEndsAt,
    councilReviewEndsAt,
    votingOpensAt,
    minVotingEndsAt: plus(votingOpensAt, minVoting),
    defaultVotingEndsAt: plus(votingOpensAt, Math.max(o.votingSeconds, minVoting)),
  };
}
