// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Board elections: each class elects its own seats by approval voting. A voter in the
 * election's class approves up to `seats` candidates; the `seats` candidates with the
 * most approvals win. Ties are broken by earlier nomination, then by user id, so the
 * result is deterministic and reproducible from the public ballot data.
 */
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Database } from "@commonair/db";
import { schema, type Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { emitEvent, systemAudit } from "./outbox.ts";
import type { MemberClass } from "./tally.ts";

export interface ElectionCandidate {
  userId: string;
  /** When the candidate was nominated (`election_candidates.nominated_at`). */
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

/**
 * `at` plus `months` calendar months in UTC, clamped to the last day of a shorter target month
 * (31 Jan + 1 month is 28/29 Feb, not 2/3 Mar).
 */
export function addUtcMonths(at: Date, months: number): Date {
  const out = new Date(at);
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(at.getUTCDate(), lastDay));
  return out;
}

export class ElectionError extends Error {
  constructor(
    public readonly code: "not_found" | "still_open",
    message: string,
  ) {
    super(message);
    this.name = "ElectionError";
  }
}

export interface ClosedElection extends ElectionResult {
  electionId: string;
  /** Candidates who no longer hold the election's class at close; they cannot be elected. */
  ineligibleCandidates: string[];
  alreadyClosed: boolean;
}

/**
 * Close an election whose voting has ended: tally the approval ballots of eligible voters,
 * record each candidate's approvals and whether they were elected, seat the winners on the
 * board for `termMonths`, and write an audit row. Closing twice returns the stored outcome.
 */
export async function closeElection(db: Database, electionId: string, now: Date): Promise<ClosedElection> {
  return db.transaction(async (tx) => {
    const [election] = await tx
      .select()
      .from(schema.elections)
      .where(eq(schema.elections.id, electionId))
      .for("update");
    if (!election) throw new ElectionError("not_found", `election ${electionId} not found`);
    const candidates = await tx
      .select()
      .from(schema.electionCandidates)
      .where(eq(schema.electionCandidates.electionId, electionId));

    if (election.status === "closed") {
      const ordered = candidates.toSorted(
        (a, b) =>
          b.votes - a.votes ||
          a.nominatedAt.getTime() - b.nominatedAt.getTime() ||
          (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
      );
      return {
        electionId,
        seats: election.seats,
        results: ordered.map((c, i) => ({ userId: c.userId, votes: c.votes, rank: i + 1, elected: c.elected })),
        ballotsCounted: 0,
        spoiled: [],
        ignoredApprovals: 0,
        ineligibleCandidates: [],
        alreadyClosed: true,
      };
    }
    if (election.votingEndsAt.getTime() > now.getTime()) {
      throw new ElectionError("still_open", `election ${electionId} is still open`);
    }

    const voters = await eligibleVoters(tx, election.class);
    const ineligible = candidates.filter((c) => !voters.has(c.userId)).map((c) => c.userId);
    const ballots = await tx
      .select({ voterId: schema.electionBallots.voterId, candidateIds: schema.electionBallots.candidateIds })
      .from(schema.electionBallots)
      .where(eq(schema.electionBallots.electionId, electionId));
    const result = tallyElection({
      seats: election.seats,
      candidates: candidates.filter((c) => voters.has(c.userId)),
      ballots,
      eligibleVoters: voters,
    });

    const byUser = new Map(result.results.map((r) => [r.userId, r]));
    for (const c of candidates) {
      const r = byUser.get(c.userId);
      await tx
        .update(schema.electionCandidates)
        .set({ votes: r?.votes ?? 0, elected: r?.elected ?? false })
        .where(
          and(eq(schema.electionCandidates.electionId, electionId), eq(schema.electionCandidates.userId, c.userId)),
        );
    }
    await tx.update(schema.elections).set({ status: "closed" }).where(eq(schema.elections.id, electionId));
    const termEnd = addUtcMonths(now, election.termMonths);
    const winners = result.results.filter((r) => r.elected);
    if (winners.length) {
      await tx
        .insert(schema.boardSeats)
        .values(winners.map((w) => ({ userId: w.userId, class: election.class, electionId, termStart: now, termEnd })));
    }
    await tx.insert(schema.auditLog).values({
      actorType: "system",
      action: "election.close",
      subjectType: "election",
      subjectId: electionId,
      reason: "voting ended",
      details: {
        elected: winners.map((w) => w.userId),
        ballotsCounted: result.ballotsCounted,
        spoiled: result.spoiled.length,
        ineligibleCandidates: ineligible,
      },
    });
    await emitEvent(
      tx,
      "coop.election.update",
      { election_id: electionId, class: election.class, status: "closed" },
      now,
    );
    return { electionId, ...result, ineligibleCandidates: ineligible, alreadyClosed: false };
  });
}

/**
 * `nominating → voting` once `nominations_close_at` has passed, compare-and-set under the row
 * lock, with its audit row and `coop.election.update` event. Returns false when another run (or
 * an admin) moved it first or it is not due.
 */
export async function openElectionVoting(db: Database, electionId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [election] = await tx
      .select()
      .from(schema.elections)
      .where(eq(schema.elections.id, electionId))
      .for("update");
    if (!election || election.status !== "nominating" || election.nominationsCloseAt.getTime() > now.getTime())
      return false;
    await tx.update(schema.elections).set({ status: "voting" }).where(eq(schema.elections.id, electionId));
    await systemAudit(
      tx,
      {
        action: "election.open_voting",
        subjectType: "election",
        subjectId: electionId,
        reason: "nominations closed",
        details: { electionId, class: election.class, seats: election.seats },
      },
      now,
    );
    await emitEvent(
      tx,
      "coop.election.update",
      { election_id: electionId, class: election.class, status: "voting" },
      now,
    );
    return true;
  });
}

export interface ElectionsAdvanceResult {
  votingOpened: number;
  closed: number;
  failed: number;
}

/**
 * One run of `elections-advance`: open voting for elections whose nominations closed, then close
 * those whose voting ended. Each election is its own transaction; one failure never blocks the
 * others (it is logged and retried on the next run).
 */
export async function advanceElections(
  db: Database,
  now: Date,
  opts: { limit?: number; logger?: Pick<Logger, "error"> } = {},
): Promise<ElectionsAdvanceResult> {
  const limit = opts.limit ?? 50;
  const result: ElectionsAdvanceResult = { votingOpened: 0, closed: 0, failed: 0 };
  const due = (
    status: "nominating" | "voting",
    at: typeof schema.elections.nominationsCloseAt | typeof schema.elections.votingEndsAt,
  ) =>
    db
      .select({ id: schema.elections.id })
      .from(schema.elections)
      .where(and(eq(schema.elections.status, status), lte(at, now)))
      .orderBy(asc(at), asc(schema.elections.id))
      .limit(limit);
  // Both lists are read first, so the run that opens an election's voting never also closes it
  // (each transition is its own step, with its own audit row and event).
  const toOpen = await due("nominating", schema.elections.nominationsCloseAt);
  const toClose = await due("voting", schema.elections.votingEndsAt);
  for (const { id } of toOpen) {
    try {
      if (await openElectionVoting(db, id, now)) result.votingOpened++;
    } catch (err) {
      result.failed++;
      opts.logger?.error("elections: opening voting failed", { electionId: id, err });
    }
  }
  for (const { id } of toClose) {
    try {
      const closed = await closeElection(db, id, now);
      if (!closed.alreadyClosed) result.closed++;
    } catch (err) {
      result.failed++;
      opts.logger?.error("elections: closing failed", { electionId: id, err });
    }
  }
  return result;
}
