// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure view builders for the co-op DTOs. Everything that decides what a caller may see lives here
 * so it is unit-tested without a database: no running tally while a vote is open, `myVote` only
 * for the caller, drafts only for their author.
 */
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import type { GovernanceChange, TallyBreakdown } from "@commonair/contracts/shapes";
import type {
  COUNCIL_STANCES,
  MEMBER_CLASSES,
  MEMBERSHIP_BASES,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  VOTE_CHOICES,
} from "@commonair/contracts/enums";
import type { MembershipClasses } from "@commonair/governance";
import { iso, isoOrNull } from "../lib/dto.ts";

export type ProposalDto = z.infer<typeof dto.ProposalView>;
export type MembershipViewDto = z.infer<typeof dto.MembershipView>;
type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
type ProposalKind = (typeof PROPOSAL_KINDS)[number];
type MemberClass = (typeof MEMBER_CLASSES)[number];
type Basis = (typeof MEMBERSHIP_BASES)[number];
type Choice = (typeof VOTE_CHOICES)[number];
type Stance = (typeof COUNCIL_STANCES)[number];

export interface ProposalFacts {
  row: {
    id: string;
    authorId: string;
    title: string;
    body: string;
    kind: ProposalKind;
    affectsCreators: boolean;
    status: ProposalStatus;
    changes: GovernanceChange[];
    discussionEndsAt: Date | null;
    councilReviewEndsAt: Date | null;
    votingStartsAt: Date | null;
    votingEndsAt: Date | null;
    decidedAt: Date | null;
    appliedAt: Date | null;
    createdAt: Date;
  };
  author: { id: string; username: string; displayName: string };
  /** Each changed key's value before the change: the current setting, or the history row once applied. */
  from: ReadonlyMap<string, unknown>;
  /** Keys protected now (`governance_settings.protected`). */
  protectedKeys: ReadonlySet<string>;
  councilResponse: { stance: Stance; body: string; publishedAt: Date } | null;
  tally: { breakdown: TallyBreakdown; passed: boolean; reason: string } | null;
  /** Counts over the frozen electorate; null before voting opened. */
  participation: { voted: number; eligible: number } | null;
  /** The caller's own vote row, if the caller voted. */
  callerVote: Choice | null;
  callerInElectorate: boolean;
  callerId: string | null;
  now: Date;
}

const DECIDED: readonly ProposalStatus[] = ["passed", "rejected", "applied"];
const REVIEW_OVER: readonly ProposalStatus[] = ["voting", "passed", "rejected", "applied"];

/**
 * A proposal that never left draft: a draft, or a draft its author withdrew (no discussion was
 * ever opened, so the trigger never set `discussion_ends_at`). Withdrawing must not publish it.
 */
export const proposalPrivate = (p: { status: ProposalStatus; discussionEndsAt: Date | null }) =>
  p.status === "draft" || (p.status === "withdrawn" && p.discussionEndsAt === null);

/** Never-submitted proposals exist only for their author (`get` → NOT_FOUND, `list` leaves them out). */
export const proposalVisibleTo = (
  p: { status: ProposalStatus; authorId: string; discussionEndsAt: Date | null },
  callerId: string | null,
) => !proposalPrivate(p) || p.authorId === callerId;

/** The voting window is open now (the trigger re-checks with the database clock). */
export function votingOpen(
  p: { status: ProposalStatus; votingStartsAt: Date | null; votingEndsAt: Date | null },
  now: Date,
): boolean {
  if (p.status !== "voting" || !p.votingStartsAt || !p.votingEndsAt) return false;
  return now.getTime() >= p.votingStartsAt.getTime() && now.getTime() <= p.votingEndsAt.getTime();
}

/** True once council review ended (or voting began) without a published response. */
export function councilResponseMissed(
  p: { affectsCreators: boolean; status: ProposalStatus; councilReviewEndsAt: Date | null },
  hasResponse: boolean,
  now: Date,
): boolean {
  if (hasResponse || !p.affectsCreators || !p.councilReviewEndsAt) return false;
  if (REVIEW_OVER.includes(p.status)) return true;
  return p.status === "council_review" && now.getTime() >= p.councilReviewEndsAt.getTime();
}

export function buildProposalView(f: ProposalFacts): ProposalDto {
  const p = f.row;
  const decided = DECIDED.includes(p.status);
  return {
    id: p.id,
    author: f.author,
    title: p.title,
    body: p.body,
    kind: p.kind,
    affectsCreators: p.affectsCreators,
    status: p.status,
    changes: p.changes.map((c) => ({
      key: c.key,
      from: f.from.get(c.key) ?? null,
      to: c.value ?? null,
      protected: f.protectedKeys.has(c.key),
    })),
    timeline: {
      discussionEndsAt: isoOrNull(p.discussionEndsAt),
      councilReviewEndsAt: isoOrNull(p.councilReviewEndsAt),
      votingStartsAt: isoOrNull(p.votingStartsAt),
      votingEndsAt: isoOrNull(p.votingEndsAt),
      decidedAt: isoOrNull(p.decidedAt),
      appliedAt: isoOrNull(p.appliedAt),
    },
    councilResponse: f.councilResponse
      ? {
          stance: f.councilResponse.stance,
          body: f.councilResponse.body,
          publishedAt: iso(f.councilResponse.publishedAt),
        }
      : null,
    councilResponseMissed: councilResponseMissed(p, f.councilResponse !== null, f.now),
    // Secret ballot: only the recorded tally of a decided proposal, never counts while voting.
    tally: decided && f.tally ? { breakdown: f.tally.breakdown, passed: f.tally.passed, reason: f.tally.reason } : null,
    participation: p.votingStartsAt ? f.participation : null,
    myVote: f.callerId ? f.callerVote : null,
    canVote: f.callerId !== null && f.callerInElectorate && votingOpen(p, f.now),
    createdAt: iso(p.createdAt),
  };
}

// Membership ------------------------------------------------------------------------------------

export interface EligibilityFacts {
  rules: MembershipClasses;
  /** Eligible streaming hours over the streamer window. */
  streamingHours: number;
  heldShareCents: number | null;
  qualifyingSubscription: boolean;
  activeWorker: boolean;
}

export type Eligibility = MembershipViewDto["eligibility"][number];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Per-class eligibility with the basis the class would use now and the progress toward it. */
export function eligibility(f: EligibilityFacts): Eligibility[] {
  const streamer = Number.isFinite(f.streamingHours) && f.streamingHours >= f.rules.streamer.minStreamingHours;
  const share = f.heldShareCents !== null && f.heldShareCents >= f.rules.viewer.shareCents;
  const subscription = f.qualifyingSubscription && f.rules.viewer.activeSubscriptionQualifies;
  const viewerBasis: Basis | null = share ? "share" : subscription ? "subscription" : null;
  return [
    {
      class: "streamer",
      eligible: streamer,
      basis: streamer ? "streaming_hours" : null,
      progress: {
        have: round2(Math.max(0, f.streamingHours)),
        need: f.rules.streamer.minStreamingHours,
        unit: "hours",
      },
      detail: `Eligible streaming hours in the last ${f.rules.streamer.windowDays} days`,
    },
    {
      class: "viewer",
      eligible: viewerBasis !== null,
      basis: viewerBasis,
      progress: { have: f.heldShareCents ?? 0, need: f.rules.viewer.shareCents, unit: "cents" },
      detail: f.rules.viewer.activeSubscriptionQualifies
        ? "A held member share, or a qualifying paid subscription"
        : "A held member share",
    },
    {
      class: "worker",
      eligible: f.activeWorker,
      basis: f.activeWorker ? "board_appointment" : null,
      progress: null,
      detail: "Appointed by board decision",
    },
  ];
}

export type MemberClassCounts = Record<MemberClass, number>;
