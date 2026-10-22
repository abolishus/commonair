// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The creator council (read-only here: the worker seats it), board elections and seats, and the
 * governance settings. Elections have no database triggers, so their rules are checked here under
 * a row lock on the election: nominate while nominating, one approval ballot per eligible voter
 * while voting, at most `seats` approvals. Ballots are secret: no view shows who approved whom,
 * and counts appear only once the election is closed.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  activeClasses,
  boardSeatsOf,
  canStandInElection,
  canVoteInElection,
  loadSettings,
} from "@commonair/governance";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { iso, loadUsersPublic } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { withCoopErrors } from "./errors.ts";
import { MEMBER, STAFF, currentCouncilTerm, unknownUser, userPicks } from "./shared.ts";

const { elections, electionCandidates, electionBallots, councilMembers, boardSeats, governanceSettings, users } =
  schema;
type ElectionRow = typeof elections.$inferSelect;

async function electionViews(db: Executor, rows: readonly ElectionRow[]) {
  if (rows.length === 0) return [];
  const candidates = await db
    .select()
    .from(electionCandidates)
    .where(
      inArray(
        electionCandidates.electionId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(electionCandidates.nominatedAt), asc(electionCandidates.userId));
  const people = await userPicks(
    db,
    candidates.map((c) => c.userId),
  );
  return rows.map((e) => ({
    id: e.id,
    class: e.class,
    seats: e.seats,
    status: e.status,
    nominationsCloseAt: iso(e.nominationsCloseAt),
    votingEndsAt: iso(e.votingEndsAt),
    candidates: candidates
      .filter((c) => c.electionId === e.id)
      .map((c) => ({
        user: people.get(c.userId) ?? unknownUser(c.userId),
        statement: c.statement,
        // No running count while voting is open.
        votes: e.status === "closed" ? c.votes : null,
        elected: e.status === "closed" && c.elected,
      })),
  }));
}

async function electionView(db: Executor, id: string) {
  const [e] = await db.select().from(elections).where(eq(elections.id, id));
  if (!e) throw notFound("Election not found");
  const [v] = await electionViews(db, [e]);
  if (!v) throw notFound("Election not found");
  return v;
}

async function lockElection(tx: Executor, id: string): Promise<ElectionRow> {
  const [e] = await tx.select().from(elections).where(eq(elections.id, id)).for("update");
  if (!e) throw notFound("Election not found");
  return e;
}

const electionEvent = (tx: Executor, e: Pick<ElectionRow, "id" | "class" | "status">, now: Date) =>
  emit(tx, "coop.election.update", null, { election_id: e.id, class: e.class, status: e.status }, now);

export const councilHandlers = {
  council: os.coop.council.handler(async ({ context }) => {
    const { db } = context.deps;
    const term = await currentCouncilTerm(db);
    if (!term) return { termId: null, startsAt: null, endsAt: null, members: [], method: {} };
    const seats = await db
      .select()
      .from(councilMembers)
      .where(eq(councilMembers.termId, term.id))
      .orderBy(asc(councilMembers.rank));
    const people = await userPicks(
      db,
      seats.map((s) => s.userId),
    );
    return {
      termId: term.id,
      startsAt: iso(term.startsAt),
      endsAt: iso(term.endsAt),
      members: seats.map((s) => ({
        user: people.get(s.userId) ?? unknownUser(s.userId),
        rank: s.rank,
        contributionScore: s.contributionScore,
      })),
      method: term.method,
    };
  }),

  board: os.coop.board.handler(async ({ context }) => {
    const { deps } = context;
    const rows = await deps.db
      .select({ seat: boardSeats, user: users })
      .from(boardSeats)
      .innerJoin(users, eq(users.id, boardSeats.userId))
      .where(sql`${boardSeats.termStart} <= now() and ${boardSeats.termEnd} > now()`)
      .orderBy(asc(boardSeats.class), asc(boardSeats.termStart));
    const people = await loadUsersPublic(
      deps,
      rows.map((r) => r.user.id),
    );
    return rows.flatMap((r) => {
      const user = people.get(r.user.id);
      return user
        ? [{ user, class: r.seat.class, termStart: iso(r.seat.termStart), termEnd: iso(r.seat.termEnd) }]
        : [];
    });
  }),

  settings: os.coop.settings.handler(async ({ context }) => {
    const rows = await context.deps.db.select().from(governanceSettings).orderBy(asc(governanceSettings.key));
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      protected: r.protected,
      description: r.description,
      updatedAt: iso(r.updatedAt),
      updatedByProposalId: r.updatedByProposalId,
    }));
  }),

  elections: {
    list: os.coop.elections.list.handler(async ({ context }) => {
      const { db } = context.deps;
      const rows = await db.select().from(elections).orderBy(desc(elections.id)).limit(50);
      return electionViews(db, rows);
    }),

    create: os.coop.elections.create.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const now = deps.now();
      const nominationsCloseAt = new Date(input.nominationsCloseAt);
      const votingEndsAt = new Date(input.votingEndsAt);
      if (nominationsCloseAt.getTime() <= now.getTime()) throw badRequest("Nominations must close in the future");
      if (votingEndsAt.getTime() <= nominationsCloseAt.getTime())
        throw badRequest("Voting must end after nominations close");
      const id = uuidv7();
      await withCoopErrors(() =>
        deps.db.transaction(async (tx) => {
          const seats = boardSeatsOf(await loadSettings(tx));
          const n = seats[input.class];
          if (n <= 0) throw precondition("board_seats", "The board has no seats for that class");
          const [open] = await tx
            .select({ id: elections.id })
            .from(elections)
            .where(and(eq(elections.class, input.class), inArray(elections.status, ["nominating", "voting"])))
            .limit(1);
          if (open) throw conflict("An election for that class is already open");
          const [e] = await tx
            .insert(elections)
            .values({
              id,
              class: input.class,
              seats: n,
              status: "nominating",
              nominationsCloseAt,
              votingEndsAt,
              termMonths: seats.termMonths,
            })
            .returning();
          if (!e) throw new Error("election insert returned nothing");
          await audit(tx, {
            actorType: STAFF,
            actorId: caller.user.id,
            action: "election.create",
            subjectType: "election",
            subjectId: id,
            details: { electionId: id, class: input.class, seats: n, termMonths: seats.termMonths },
          });
          await electionEvent(tx, e, now);
        }),
      );
      return electionView(deps.db, id);
    }),

    nominate: os.coop.elections.nominate.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      await withCoopErrors(() =>
        deps.db.transaction(async (tx) => {
          const now = deps.now();
          const e = await lockElection(tx, input.id);
          if (e.status !== "nominating" || now.getTime() >= e.nominationsCloseAt.getTime())
            throw conflict("Nominations are closed");
          if (!canStandInElection(await activeClasses(tx, caller.user.id), e.class))
            throw forbidden("Only members of that class can stand");
          const [row] = await tx
            .insert(electionCandidates)
            .values({ electionId: e.id, userId: caller.user.id, statement: input.statement.trim() })
            .onConflictDoNothing()
            .returning();
          if (!row) throw conflict("You are already a candidate");
          await audit(tx, {
            actorType: MEMBER,
            actorId: caller.user.id,
            action: "election.nominate",
            subjectType: "election",
            subjectId: e.id,
            details: { electionId: e.id, class: e.class },
          });
          await electionEvent(tx, e, now);
        }),
      );
      return electionView(deps.db, input.id);
    }),

    vote: os.coop.elections.vote.handler(async ({ context, input }) => {
      const { deps } = context;
      const caller = requireCaller(context);
      const picks = [...new Set(input.candidateIds)];
      if (picks.length !== input.candidateIds.length) throw badRequest("Approve each candidate once");
      await withCoopErrors(() =>
        deps.db.transaction(async (tx) => {
          const now = deps.now();
          const e = await lockElection(tx, input.id);
          if (e.status !== "voting" || now.getTime() >= e.votingEndsAt.getTime()) throw conflict("Voting is closed");
          if (!canVoteInElection(await activeClasses(tx, caller.user.id), e.class))
            throw forbidden("Only members of that class can vote");
          if (picks.length > e.seats) throw badRequest(`Approve at most ${e.seats} candidates`);
          const known = await tx
            .select({ userId: electionCandidates.userId })
            .from(electionCandidates)
            .where(and(eq(electionCandidates.electionId, e.id), inArray(electionCandidates.userId, picks)));
          if (known.length !== picks.length) throw badRequest("Approve only this election's candidates");
          const [row] = await tx
            .insert(electionBallots)
            .values({ electionId: e.id, voterId: caller.user.id, candidateIds: picks })
            .onConflictDoNothing()
            .returning({ electionId: electionBallots.electionId });
          if (!row) throw conflict("You already voted in this election");
          // Secret ballot: never whom the voter approved.
          await audit(tx, {
            actorType: MEMBER,
            actorId: caller.user.id,
            action: "election.vote",
            subjectType: "election",
            subjectId: e.id,
            details: { electionId: e.id },
          });
          await electionEvent(tx, e, now);
        }),
      );
      return electionView(deps.db, input.id);
    }),
  },
};
