// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  GovernanceChange,
  GovernanceRuleSnapshot,
  PatronageLine,
  PatronageWeights,
  TallyBreakdown,
} from "@commonair/contracts/shapes";
import { users } from "./auth.ts";
import { payments } from "./money.ts";
import {
  cents,
  councilStance,
  createdAt,
  electionStatus,
  id,
  memberClass,
  membershipBasis,
  membershipStatus,
  patronageStatus,
  proposalKind,
  proposalStatus,
  shareStatus,
  ts,
  updatedAt,
  voteChoice,
} from "./_shared.ts";

/** One row per (person, class). A person holds at most one active membership per class. */
export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    class: memberClass().notNull(),
    status: membershipStatus().notNull().default("active"),
    basis: membershipBasis().notNull(),
    joinedAt: ts().notNull().defaultNow(),
    lapsedAt: ts(),
    exitedAt: ts(),
    lastEligibilityCheckAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("memberships_active_uq")
      .on(t.userId, t.class)
      .where(sql`${t.status} = 'active'`),
    index("memberships_class_idx").on(t.class, t.status),
  ],
);

export const membershipShares = pgTable(
  "membership_shares",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountCents: cents().notNull(),
    currency: text().notNull(),
    paymentId: uuid().references(() => payments.id, { onDelete: "restrict" }),
    status: shareStatus().notNull().default("pending"),
    purchasedAt: ts(),
    refundedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    // `refund_pending` also counts as open; the share trigger (0021) checks it, because an index
    // predicate cannot use enum values added in the same migration run.
    uniqueIndex("membership_shares_held_uq")
      .on(t.userId)
      .where(sql`${t.status} in ('pending', 'held')`),
    index("membership_shares_status_idx").on(t.status, t.createdAt),
  ],
);

/**
 * Governance-controlled settings. Protected keys can only change through an
 * applied proposal that passed the protected-decision rule; a trigger enforces
 * this, so neither admins nor application bugs can bypass it.
 */
export const governanceSettings = pgTable("governance_settings", {
  key: text().primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
  /** Maintained by trigger: true iff the key is listed in governance.protections.protectedKeys. */
  protected: boolean().notNull(),
  description: text().notNull(),
  updatedAt: updatedAt(),
  updatedByProposalId: uuid().references((): AnyPgColumn => proposals.id, { onDelete: "restrict" }),
});

/** Each (proposal, setting) change is applied exactly once; written only by the settings trigger. */
export const governanceApplications = pgTable(
  "governance_applications",
  {
    proposalId: uuid()
      .notNull()
      .references((): AnyPgColumn => proposals.id, { onDelete: "restrict" }),
    key: text().notNull(),
    appliedAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.key] })],
);

export const governanceSettingsHistory = pgTable(
  "governance_settings_history",
  {
    id: id(),
    key: text().notNull(),
    oldValue: jsonb().$type<unknown>(),
    newValue: jsonb().$type<unknown>().notNull(),
    proposalId: uuid(),
    changedAt: ts().notNull().defaultNow(),
  },
  (t) => [index("governance_settings_history_key_idx").on(t.key, t.changedAt)],
);

export const proposals = pgTable(
  "proposals",
  {
    id: id(),
    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: text().notNull(),
    body: text().notNull(),
    /** Computed from `changes`: protected if any change touches a protected setting. */
    kind: proposalKind().notNull(),
    affectsCreators: boolean().notNull(),
    status: proposalStatus().notNull().default("draft"),
    changes: jsonb().$type<GovernanceChange[]>().notNull().default([]),
    /** Rules frozen when voting opens, so later setting changes cannot alter an open vote. */
    rules: jsonb().$type<GovernanceRuleSnapshot>(),
    discussionEndsAt: ts(),
    /** Set by trigger on entering council review; the review length comes from governance.protections. */
    councilReviewStartedAt: ts(),
    councilReviewEndsAt: ts(),
    votingStartsAt: ts(),
    votingEndsAt: ts(),
    decidedAt: ts(),
    appliedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("proposals_status_idx").on(t.status, t.votingEndsAt)],
);

export const proposalComments = pgTable(
  "proposal_comments",
  {
    id: id(),
    proposalId: uuid()
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    authorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("proposal_comments_proposal_idx").on(t.proposalId, t.createdAt)],
);

/** Snapshot of who may vote: built by the proposals trigger from active memberships when voting opens. */
export const proposalElectorate = pgTable(
  "proposal_electorate",
  {
    proposalId: uuid()
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    classes: memberClass().array().notNull(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.userId] })],
);

export const votes = pgTable(
  "votes",
  {
    id: id(),
    proposalId: uuid()
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    choice: voteChoice().notNull(),
    castAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex("votes_one_per_member_uq").on(t.proposalId, t.userId)],
);

/** Append-only trail of every vote cast or changed (written by trigger). */
export const voteHistory = pgTable(
  "vote_history",
  {
    id: id(),
    proposalId: uuid().notNull(),
    userId: uuid().notNull(),
    choice: voteChoice().notNull(),
    castAt: ts().notNull(),
  },
  (t) => [index("vote_history_proposal_idx").on(t.proposalId, t.castAt)],
);

/** Append-only trail of membership changes (written by trigger). */
export const membershipHistory = pgTable(
  "membership_history",
  {
    id: id(),
    membershipId: uuid().notNull(),
    userId: uuid().notNull(),
    class: memberClass().notNull(),
    status: membershipStatus().notNull(),
    basis: membershipBasis().notNull(),
    op: text().notNull(),
    at: ts().notNull(),
  },
  (t) => [index("membership_history_user_idx").on(t.userId, t.at)],
);

export const tallies = pgTable("tallies", {
  proposalId: uuid()
    .primaryKey()
    .references(() => proposals.id, { onDelete: "cascade" }),
  breakdown: jsonb().$type<TallyBreakdown>().notNull(),
  passed: boolean().notNull(),
  reason: text().notNull(),
  computedAt: ts().notNull().defaultNow(),
});

export const councilTerms = pgTable("council_terms", {
  id: id(),
  computedAt: ts().notNull().defaultNow(),
  startsAt: ts().notNull(),
  endsAt: ts().notNull(),
  /** Inputs used to seat the council (eligibility window, size), for auditability. */
  method: jsonb().$type<Record<string, unknown>>().notNull(),
  /** Set by trigger: seats are inserted only in the transaction that created the term (0021). */
  txid: bigint({ mode: "number" })
    .notNull()
    .default(sql`txid_current()`),
});

export const councilMembers = pgTable(
  "council_members",
  {
    termId: uuid()
      .notNull()
      .references(() => councilTerms.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    rank: integer().notNull(),
    contributionScore: doublePrecision().notNull(),
  },
  (t) => [primaryKey({ columns: [t.termId, t.userId] })],
);

export const councilResponses = pgTable("council_responses", {
  proposalId: uuid()
    .primaryKey()
    .references(() => proposals.id, { onDelete: "cascade" }),
  termId: uuid()
    .notNull()
    .references(() => councilTerms.id, { onDelete: "restrict" }),
  stance: councilStance().notNull(),
  body: text().notNull(),
  publishedById: uuid()
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  publishedAt: ts().notNull().defaultNow(),
});

export const elections = pgTable("elections", {
  id: id(),
  class: memberClass().notNull(),
  seats: integer().notNull(),
  status: electionStatus().notNull().default("nominating"),
  nominationsCloseAt: ts().notNull(),
  votingEndsAt: ts().notNull(),
  termMonths: integer().notNull(),
  createdAt: createdAt(),
});

export const electionCandidates = pgTable(
  "election_candidates",
  {
    electionId: uuid()
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    statement: text().notNull().default(""),
    /** Tie-break: earlier nominations win ties. */
    nominatedAt: ts().notNull().defaultNow(),
    votes: integer().notNull().default(0),
    elected: boolean().notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.userId] })],
);

/** Approval ballots: a voter (in the election's class) may approve up to `seats` candidates. */
export const electionBallots = pgTable(
  "election_ballots",
  {
    electionId: uuid()
      .notNull()
      .references(() => elections.id, { onDelete: "cascade" }),
    voterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    candidateIds: uuid().array().notNull(),
    castAt: ts().notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.electionId, t.voterId] })],
);

export const boardSeats = pgTable(
  "board_seats",
  {
    id: id(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    class: memberClass().notNull(),
    electionId: uuid().references(() => elections.id, { onDelete: "set null" }),
    termStart: ts().notNull(),
    termEnd: ts().notNull(),
  },
  (t) => [index("board_seats_term_idx").on(t.termEnd)],
);

export const patronagePeriods = pgTable(
  "patronage_periods",
  {
    id: id(),
    periodStart: ts().notNull(),
    periodEnd: ts().notNull(),
    status: patronageStatus().notNull().default("draft"),
    formulaVersion: text().notNull(),
    weights: jsonb().$type<PatronageWeights>().notNull(),
    surplusCents: cents().notNull().default(0),
    /** Surplus not allocated to members (empty pools, cap overflow) and why, line by line. */
    retainedCents: cents().notNull().default(0),
    retainedLines: jsonb().$type<PatronageLine[]>().notNull().default([]),
    currency: text().notNull(),
    computedAt: ts(),
    /** The treasurer who ran the computation; the approver must be someone else (ADR 0020, trigger). */
    computedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    approvedAt: ts(),
    approvedById: uuid().references(() => users.id, { onDelete: "restrict" }),
    ledgerTransactionId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("patronage_periods_uq").on(t.periodStart, t.periodEnd)],
);

export const patronageInputs = pgTable(
  "patronage_inputs",
  {
    periodId: uuid()
      .notNull()
      .references(() => patronagePeriods.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    revenueCents: cents().notNull().default(0),
    eligibleStreamingHours: doublePrecision().notNull().default(0),
    relayBytesVerified: bigint({ mode: "number" }).notNull().default(0),
    viewerHoursVerified: doublePrecision().notNull().default(0),
    viewerHoursExcluded: doublePrecision().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.periodId, t.userId] })],
);

export const patronageAllocations = pgTable(
  "patronage_allocations",
  {
    periodId: uuid()
      .notNull()
      .references(() => patronagePeriods.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountCents: cents().notNull(),
    /** Every line of the statement: pool, member share, cap applied, rounding. */
    lines: jsonb().$type<PatronageLine[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.periodId, t.userId] })],
);
