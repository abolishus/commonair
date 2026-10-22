// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Contract-shaped fixtures for the co-op page tests. */
import type {
  CoopMonthDto,
  CouncilDto,
  ElectionDto,
  MembershipViewDto,
  PatronagePeriodDto,
  ProposalCommentDto,
  ProposalDto,
  SettingDto,
  ShareDto,
  StatementDto,
} from "../src/lib/coop.ts";

export const ME = "0192d6f1-0000-7000-8000-0000000000a1";
export const OTHER = "0192d6f1-0000-7000-8000-0000000000b2";
export const PROPOSAL_ID = "0192d6f1-0000-7000-8000-000000000047";
export const PERIOD_ID = "0192d6f1-0000-7000-8000-0000000000c3";

export const usd = (cents: number) => ({ cents, currency: "usd" });

const user = (id: string, username: string) => ({ id, username, displayName: username });

export function membershipView(over: Partial<MembershipViewDto> = {}): MembershipViewDto {
  return {
    memberships: [
      {
        id: "m-streamer",
        class: "streamer",
        status: "active",
        basis: "streaming_hours",
        joinedAt: "2026-10-01T00:00:00.000Z",
      },
      { id: "m-viewer", class: "viewer", status: "active", basis: "share", joinedAt: "2026-10-02T00:00:00.000Z" },
      {
        id: "m-worker",
        class: "worker",
        status: "exited",
        basis: "board_appointment",
        joinedAt: "2026-09-02T00:00:00.000Z",
      },
    ],
    eligibility: [
      {
        class: "streamer",
        eligible: true,
        basis: "streaming_hours",
        progress: { have: 12.5, need: 10, unit: "hours" },
        detail: "",
      },
      {
        class: "viewer",
        eligible: true,
        basis: "share",
        progress: { have: 2500, need: 2500, unit: "cents" },
        detail: "",
      },
      { class: "worker", eligible: false, basis: null, progress: null, detail: "Appointed by the board" },
    ],
    share: { id: "s1", status: "held", amount: usd(2500), paymentId: null, reference: null, instructions: null },
    ...over,
  };
}

export const settings: SettingDto[] = [
  {
    key: "discovery.ranking",
    value: { spotlightSlots: 4, newChannelBoostDays: 14 },
    protected: false,
    description: "How the directory ranks channels.",
    updatedAt: "2026-10-01T00:00:00.000Z",
    updatedByProposalId: PROPOSAL_ID,
  },
  {
    key: "platform.cut",
    value: { streamerShare: 0.71 },
    protected: true,
    description: "The creator share of revenue.",
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedByProposalId: null,
  },
  {
    key: "membership.classes",
    value: {
      streamer: { minStreamingHours: 10, windowDays: 30 },
      viewer: { shareCents: 2500, shareRefundableOnExit: true, activeSubscriptionQualifies: true },
      worker: { appointedBy: "board" },
    },
    protected: true,
    description: "Who qualifies for each class.",
    updatedAt: "2026-09-01T00:00:00.000Z",
    updatedByProposalId: null,
  },
];

const timeline = {
  discussionEndsAt: null,
  councilReviewEndsAt: null,
  votingStartsAt: null,
  votingEndsAt: null,
  decidedAt: null,
  appliedAt: null,
};

export function proposal(over: Partial<ProposalDto> = {}): ProposalDto {
  return {
    id: PROPOSAL_ID,
    author: user(ME, "rivertide"),
    title: "Five spotlight slots",
    body: "More room for small channels.",
    kind: "ordinary",
    affectsCreators: true,
    status: "draft",
    changes: [{ key: "discovery.ranking", from: { spotlightSlots: 4 }, to: { spotlightSlots: 5 }, protected: false }],
    timeline,
    councilResponse: null,
    councilResponseMissed: false,
    tally: null,
    participation: null,
    myVote: null,
    canVote: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
export const NOW = T0;
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** A proposal in voting whose window is still open at NOW. */
export function votingProposal(over: Partial<ProposalDto> = {}): ProposalDto {
  return proposal({
    status: "voting",
    timeline: {
      ...timeline,
      discussionEndsAt: at(-30),
      councilReviewEndsAt: at(-10),
      votingStartsAt: at(-10),
      votingEndsAt: at(10),
    },
    councilResponse: { stance: "support", body: "Good for small channels.", publishedAt: at(-15) },
    participation: { voted: 3, eligible: 4 },
    myVote: "yes",
    canVote: true,
    ...over,
  });
}

export function rejectedProtected(): ProposalDto {
  return proposal({
    kind: "protected",
    status: "rejected",
    changes: [{ key: "platform.cut", from: { streamerShare: 0.71 }, to: { streamerShare: 0.85 }, protected: true }],
    timeline: {
      discussionEndsAt: at(-60),
      councilReviewEndsAt: at(-40),
      votingStartsAt: at(-40),
      votingEndsAt: at(-5),
      decidedAt: at(-4),
      appliedAt: null,
    },
    councilResponse: { stance: "oppose", body: "Too much.", publishedAt: at(-45) },
    participation: { voted: 4, eligible: 4 },
    myVote: "yes",
    tally: {
      passed: false,
      reason: "streamer-class majority not met",
      breakdown: {
        memberWide: { eligible: 4, yes: 3, no: 1, abstain: 0 },
        byClass: {
          streamer: { eligible: 2, yes: 1, no: 1, abstain: 0 },
          viewer: { eligible: 1, yes: 1, no: 0, abstain: 0 },
          worker: { eligible: 1, yes: 1, no: 0, abstain: 0 },
        },
        checks: [
          { rule: "member_wide_quorum", passed: true, detail: "turnout 4/4 (100.00%), at least 1.00% required" },
          { rule: "member_wide_threshold", passed: true, detail: "yes 3/4 (75.00%), at least 66.67% required" },
          { rule: "streamer_class_quorum", passed: true, detail: "streamer turnout 2/2 (100.00%)" },
          {
            rule: "streamer_class_majority",
            passed: false,
            detail: "streamer yes 1/2 (50.00%), more than 50% required",
          },
        ],
      },
    },
  });
}

export const comments: ProposalCommentDto[] = [
  { id: "c1", author: user(OTHER, "ohmslaw"), body: "Yes please.", createdAt: at(-20) },
  { id: "c2", author: user(ME, "rivertide"), body: "Thanks.", createdAt: at(-19) },
];

export const council: CouncilDto = {
  termId: "term-1",
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: "2026-10-31T23:59:59.000Z",
  members: [
    { user: user(ME, "rivertide"), rank: 1, contributionScore: 41.5 },
    { user: user(OTHER, "ohmslaw"), rank: 2, contributionScore: 12 },
  ],
  method: { windowDays: 30, size: 7, weights: { revenue: 0.5 }, eligible: 2 },
};

export const elections: ElectionDto[] = [
  {
    id: "e1",
    class: "viewer",
    seats: 1,
    status: "nominating",
    nominationsCloseAt: at(60 * 24),
    votingEndsAt: at(60 * 24 * 7),
    candidates: [{ user: user(OTHER, "ohmslaw"), statement: "I will listen.", votes: null, elected: false }],
  },
];

export const board = [{ user: user(OTHER, "ohmslaw"), class: "viewer" as const, termStart: at(-60), termEnd: at(60) }];

export function share(id: string, status: ShareDto["status"]): ShareDto {
  return {
    id,
    user: user(OTHER, "ohmslaw"),
    status,
    amount: usd(2500),
    paymentId: "p1",
    purchasedAt: at(-100),
    refundedAt: null,
    createdAt: at(-120),
  };
}

export function period(
  id: string,
  status: PatronagePeriodDto["status"],
  computedBy: string | null,
): PatronagePeriodDto {
  return {
    id,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-10-20T00:00:00.000Z",
    status,
    formulaVersion: "patronage-2026.1",
    surplus: usd(10_000),
    total: usd(9_000),
    retained: usd(1_000),
    members: 3,
    computedAt: at(-5),
    computedBy: computedBy ? { id: computedBy, username: computedBy === ME ? "rivertide" : "ohmslaw" } : null,
    approvedAt: status === "approved" ? at(-1) : null,
    approvedBy: status === "approved" ? { id: OTHER, username: "ohmslaw" } : null,
  };
}

export const statement: StatementDto = {
  periodId: PERIOD_ID,
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-10-20T00:00:00.000Z",
  status: "approved",
  formulaVersion: "patronage-2026.1",
  weights: {
    revenue: 0.5,
    streamingHours: 0.2,
    relayBandwidth: 0.1,
    viewerHours: 0.2,
    dailyStreamingHourCap: 12,
    viewerHoursChannelCap: 0.2,
  },
  surplus: usd(10_000),
  total: usd(4_200),
  lines: [
    {
      component: "revenue",
      explanation: "Revenue: $10.00 of $20.00 (50.00%) × 50% pool",
      memberValue: 1000,
      poolTotal: 2000,
      share: 0.5,
      poolCents: 5000,
      amountCents: 2500,
      capApplied: false,
    },
    {
      component: "streamingHours",
      explanation: "Streaming hours: 2 of 4 (50.00%) × 20% pool, at most 12 h per day",
      memberValue: 2,
      poolTotal: 4,
      share: 0.5,
      poolCents: 2000,
      amountCents: 1000,
      capApplied: true,
    },
  ],
  inputs: {
    revenueCents: 1000,
    eligibleStreamingHours: 2,
    relayBytesVerified: 0,
    viewerHoursVerified: 7.5,
    viewerHoursExcluded: 0.5,
  },
};

export function month(key: string, over: Partial<CoopMonthDto> = {}): CoopMonthDto {
  return {
    month: key,
    revenue: usd(10_000),
    streamerPayouts: usd(6000),
    coopRetained: usd(1500),
    costs: [],
    surplus: usd(1100),
    patronageDistributed: usd(0),
    egressBySource: { origin: 600, relay: 400, p2p: 0, cdn: 0 },
    governance: [],
    members: { streamer: 2, viewer: 1, worker: 1 },
    ...over,
  };
}
