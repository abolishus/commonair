// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Board elections: each class elects its own seats by approval voting. A voter in the
 * election's class approves up to `seats` candidates; the `seats` candidates with the
 * most approvals win. Ties are broken by earlier nomination, then by user id, so the
 * result is deterministic and reproducible from the public ballot data.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import type { MemberClass } from "./tally.ts";

export interface ElectionCandidate {
  userId: string;
  /**
   * When the candidate was nominated. CONTRACT-REQUEST: `election_candidates` has no
   * nomination timestamp yet; add `nominated_at timestamptz not null default now()`.
   */
  nominatedAt: Date;
}

export interface ElectionBallot {
  voterId: string;
  candidateIds: readonly string[];
}

export type SpoiledReason = "ineligible_voter" | "too_many_approvals" | "duplicate_ballot";

export interface ElectionResult {
  seats: number;
  results: { userId: string; votes: number; rank: number; elected: boolean }[];
  ballotsCounted: number;
  spoiled: { voterId: string; reason: SpoiledReason }[];
  /** Approvals naming someone who is not a candidate (ignored, ballot still counted). */
  ignoredApprovals: number;
}

/** A voter may vote, and a candidate may stand, only in an election for a class they hold. */
export const canVoteInElection = (voterClasses: readonly MemberClass[], electionClass: MemberClass) =>
  voterClasses.includes(electionClass);
export const canStandInElection = (candidateClasses: readonly MemberClass[], electionClass: MemberClass) =>
  candidateClasses.includes(electionClass);

/**
 * Tally an approval election. `eligibleVoters` (when given) is the set of voters
 * holding the election's class; ballots from anyone else are spoiled. Elected
 * candidates need at least one approval.
 */
export function tallyElection(input: {
  seats: number;
  candidates: readonly ElectionCandidate[];
  ballots: readonly ElectionBallot[];
  eligibleVoters?: ReadonlySet<string>;
}): ElectionResult {
  const votes = new Map<string, number>(input.candidates.map((c) => [c.userId, 0]));
  const spoiled: ElectionResult["spoiled"] = [];
  const voted = new Set<string>();
  let counted = 0;
  let ignored = 0;
  for (const b of input.ballots) {
    if (voted.has(b.voterId)) {
      spoiled.push({ voterId: b.voterId, reason: "duplicate_ballot" });
      continue;
    }
    voted.add(b.voterId);
    if (input.eligibleVoters && !input.eligibleVoters.has(b.voterId)) {
      spoiled.push({ voterId: b.voterId, reason: "ineligible_voter" });
      continue;
    }
    const named = new Set(b.candidateIds);
    const approvals = [...named].filter((id) => votes.has(id));
    if (approvals.length > input.seats) {
      spoiled.push({ voterId: b.voterId, reason: "too_many_approvals" });
      continue;
    }
    counted++;
    ignored += named.size - approvals.length;
    for (const id of approvals) votes.set(id, (votes.get(id) ?? 0) + 1);
  }

  const ordered = [...input.candidates].sort(
    (a, b) =>
      (votes.get(b.userId) ?? 0) - (votes.get(a.userId) ?? 0) ||
      a.nominatedAt.getTime() - b.nominatedAt.getTime() ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
  return {
    seats: input.seats,
    results: ordered.map((c, i) => {
      const v = votes.get(c.userId) ?? 0;
      return { userId: c.userId, votes: v, rank: i + 1, elected: i < input.seats && v > 0 };
    }),
    ballotsCounted: counted,
    spoiled,
    ignoredApprovals: ignored,
  };
}

/** Classes in which the user currently holds an active membership. */
export async function activeClasses(db: Executor, userId: string): Promise<MemberClass[]> {
  const rows = await db
    .selectDistinct({ class: schema.memberships.class })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.status, "active")));
  return rows.map((r) => r.class).sort();
}

/** Active members of a class (users not banned or deleted): the eligible voters of its election. */
export async function eligibleVoters(db: Executor, electionClass: MemberClass): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(
      and(
        eq(schema.memberships.class, electionClass),
        eq(schema.memberships.status, "active"),
        eq(schema.users.banned, false),
        sql`${schema.users.deletedAt} is null`,
      ),
    );
  return new Set(rows.map((r) => r.userId));
}
