// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Proposals: drafting, discussion, council responses and votes (docs/testing/e5-selectors.md
 * "Proposal flows"). The API never moves a proposal past discussion, never writes `tallies` or
 * settings: the worker does, and the triggers re-check every step. Each action writes its audit
 * row and outbox event in its transaction. Secret ballot: a choice is written to `votes` only and
 * returned only to its voter.
 */
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { VOTE_CHOICES } from "@commonair/contracts/enums";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { loadSettings } from "@commonair/governance";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso } from "../lib/dto.ts";
import { apiError, badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { withCoopErrors } from "./errors.ts";
import { type ActionFacts, type ProposalAction, type Refusal, refuseProposalAction } from "./policy.ts";
import { MEMBER, classifyDraft, currentCouncilTerm, isActiveMember, unknownUser, userPicks } from "./shared.ts";
import { buildProposalView, proposalPrivate, proposalVisibleTo, type ProposalDto } from "./views.ts";

const { proposals, proposalComments, proposalElectorate, votes, tallies, councilResponses, governanceSettings } =
  schema;
type ProposalRow = typeof proposals.$inferSelect;
type Choice = (typeof VOTE_CHOICES)[number];

/** Build the views of `rows` for `callerId` with a handful of batched reads. */
export async function proposalViews(
  db: Executor,
  rows: readonly ProposalRow[],
  callerId: string | null,
  now: Date,
): Promise<ProposalDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const opened = rows.filter((r) => r.votingStartsAt !== null).map((r) => r.id);
  const applied = rows.filter((r) => r.status === "applied").map((r) => r.id);
  const [authors, settings, history, responses, tallyRows, electorate, cast, mine] = await Promise.all([
    userPicks(
      db,
      rows.map((r) => r.authorId),
    ),
    db
      .select({ key: governanceSettings.key, value: governanceSettings.value, protected: governanceSettings.protected })
      .from(governanceSettings),
    applied.length
      ? db
          .select({
            proposalId: schema.governanceSettingsHistory.proposalId,
            key: schema.governanceSettingsHistory.key,
            oldValue: schema.governanceSettingsHistory.oldValue,
          })
          .from(schema.governanceSettingsHistory)
          .where(inArray(schema.governanceSettingsHistory.proposalId, applied))
      : Promise.resolve([]),
    db
      .select({
        proposalId: councilResponses.proposalId,
        stance: councilResponses.stance,
        body: councilResponses.body,
        publishedAt: councilResponses.publishedAt,
      })
      .from(councilResponses)
      .where(inArray(councilResponses.proposalId, ids)),
    db.select().from(tallies).where(inArray(tallies.proposalId, ids)),
    opened.length
      ? db
          .select({ proposalId: proposalElectorate.proposalId, n: sql<string>`count(*)::text` })
          .from(proposalElectorate)
          .where(inArray(proposalElectorate.proposalId, opened))
          .groupBy(proposalElectorate.proposalId)
      : Promise.resolve([]),
    // Counts only (secret ballot); the same rule as the SQL tally: electorate votes in the window.
    opened.length
      ? db.execute<{ proposal_id: string; n: string }>(sql`
          select v.proposal_id, count(*)::text as n
            from votes v
            join proposal_electorate e on e.proposal_id = v.proposal_id and e.user_id = v.user_id
            join proposals p on p.id = v.proposal_id
           where v.proposal_id in (${sql.join(
             opened.map((id) => sql`${id}::uuid`),
             sql`, `,
           )}) and v.cast_at <= p.voting_ends_at
           group by v.proposal_id`)
      : Promise.resolve([]),
    callerId && opened.length
      ? Promise.all([
          db
            .select({ proposalId: votes.proposalId, choice: votes.choice })
            .from(votes)
            .where(and(eq(votes.userId, callerId), inArray(votes.proposalId, opened))),
          db
            .select({ proposalId: proposalElectorate.proposalId })
            .from(proposalElectorate)
            .where(and(eq(proposalElectorate.userId, callerId), inArray(proposalElectorate.proposalId, opened))),
        ])
      : Promise.resolve([[], []] as const),
  ]);
  const current = new Map(settings.map((s) => [s.key, s.value]));
  const protectedKeys = new Set(settings.filter((s) => s.protected).map((s) => s.key));
  const old = new Map<string, Map<string, unknown>>();
  for (const h of history) {
    if (!h.proposalId) continue;
    const m = old.get(h.proposalId) ?? new Map<string, unknown>();
    m.set(h.key, h.oldValue);
    old.set(h.proposalId, m);
  }
  const eligible = new Map(electorate.map((e) => [e.proposalId, Number(e.n)]));
  const voted = new Map([...cast].map((c) => [c.proposal_id, Number(c.n)]));
  const myVotes = new Map<string, Choice>(mine[0].map((v) => [v.proposalId, v.choice]));
  const inElectorate = new Set(mine[1].map((e) => e.proposalId));
  const response = new Map(responses.map((r) => [r.proposalId, r]));
  const tally = new Map(tallyRows.map((t) => [t.proposalId, t]));

  return rows.map((row) => {
    const from = new Map<string, unknown>();
    const before = old.get(row.id);
    for (const c of row.changes) from.set(c.key, before?.has(c.key) ? before.get(c.key) : current.get(c.key));
    const r = response.get(row.id);
    const t = tally.get(row.id);
    return buildProposalView({
      row,
      author: authors.get(row.authorId) ?? unknownUser(row.authorId),
      from,
      protectedKeys,
      councilResponse: r ? { stance: r.stance, body: r.body, publishedAt: r.publishedAt } : null,
      tally: t ? { breakdown: t.breakdown, passed: t.passed, reason: t.reason } : null,
      participation: row.votingStartsAt ? { voted: voted.get(row.id) ?? 0, eligible: eligible.get(row.id) ?? 0 } : null,
      callerVote: myVotes.get(row.id) ?? null,
      callerInElectorate: inElectorate.has(row.id),
      callerId,
      now,
    });
  });
}

async function viewOne(db: Executor, id: string, callerId: string | null, now: Date): Promise<ProposalDto> {
  const [row] = await db.select().from(proposals).where(eq(proposals.id, id));
  if (!row || !proposalVisibleTo(row, callerId)) throw notFound("Proposal not found");
  const [v] = await proposalViews(db, [row], callerId, now);
  if (!v) throw notFound("Proposal not found");
  return v;
}

const toError = (r: Refusal) => {
  switch (r.code) {
    case "NOT_FOUND":
      return notFound(r.message);
    case "FORBIDDEN":
      return apiError("FORBIDDEN", r.message, r.reason ? { reason: r.reason } : undefined);
    case "CONFLICT":
      return apiError("CONFLICT", r.message, r.reason ? { reason: r.reason } : undefined);
    case "PRECONDITION_FAILED":
      return precondition(r.requirement, r.message);
  }
};

/** Throw unless the policy allows `action` (facts default to "not a member, not seated"). */
function check(action: ProposalAction, f: Partial<ActionFacts> & Pick<ActionFacts, "proposal" | "callerId" | "now">) {
  const r = refuseProposalAction(action, {
    member: false,
    inElectorate: false,
    seated: false,
    responded: false,
    ...f,
  });
  if (r) throw toError(r);
}

/** The proposal row, locked: `update` for the author's own changes, `share` for votes and comments. */
async function lockProposal(
  tx: Executor,
  id: string,
  callerId: string,
  mode: "update" | "share",
): Promise<ProposalRow> {
  const [row] = await tx.select().from(proposals).where(eq(proposals.id, id)).for(mode);
  if (!row || !proposalVisibleTo(row, callerId)) throw notFound("Proposal not found");
  return row;
}

/**
 * `coop.proposal.update` is public (apps, webhooks, EventSub), so it starts at submit: a draft, its
 * edits and its withdrawal stay with the author and emit nothing (the audit row records them).
 */
async function proposalEvent(
  tx: Executor,
  p: Pick<ProposalRow, "id" | "title" | "status" | "kind" | "discussionEndsAt">,
  now: Date,
) {
  if (proposalPrivate(p)) return;
  await emit(
    tx,
    "coop.proposal.update",
    null,
    { proposal_id: p.id, title: p.title, status: p.status, kind: p.kind, passed: null, reason: null },
    now,
  );
}

const draftInput = async (
  tx: Executor,
  input: { title: string; body: string; changes: { key: string; value?: unknown }[]; affectsCreators: boolean },
) => {
  const changes = input.changes.map((c) => ({ key: c.key, value: c.value ?? null }));
  const c = classifyDraft(changes, input.affectsCreators, await loadSettings(tx));
  if (!c.ok) throw badRequest(c.reason);
  const title = input.title.trim();
  if (title.length < 5) throw badRequest("The title is too short");
  return { title, body: input.body, changes, kind: c.kind, affectsCreators: c.affectsCreators, keys: c.keys };
};

export const proposalHandlers = {
  list: os.coop.proposals.list.handler(async ({ context, input }) => {
    const { deps } = context;
    const callerId = context.caller?.user.id ?? null;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    // The SQL form of `proposalVisibleTo`: never-submitted proposals only for their author.
    const isPublic = sql`not (${proposals.status} = 'draft' or (${proposals.status} = 'withdrawn' and ${proposals.discussionEndsAt} is null))`;
    const visible = callerId ? or(isPublic, eq(proposals.authorId, callerId)) : isPublic;
    const rows = await deps.db
      .select()
      .from(proposals)
      .where(
        and(
          visible,
          input.status ? eq(proposals.status, input.status) : undefined,
          cur ? lt(proposals.id, cur.id) : undefined,
        ),
      )
      .orderBy(desc(proposals.id))
      .limit(input.limit + 1);
    const page = pageOf(
      rows,
      input.limit,
      (r) => r,
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
    return { items: await proposalViews(deps.db, page.items, callerId, deps.now()), nextCursor: page.nextCursor };
  }),

  get: os.coop.proposals.get.handler(async ({ context, input }) =>
    viewOne(context.deps.db, input.id, context.caller?.user.id ?? null, context.deps.now()),
  ),

  create: os.coop.proposals.create.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const id = uuidv7();
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        if (!(await isActiveMember(tx, caller.user.id)))
          throw precondition("membership", "Only members can draft proposals");
        const d = await draftInput(tx, input);
        const [row] = await tx
          .insert(proposals)
          .values({
            id,
            authorId: caller.user.id,
            title: d.title,
            body: d.body,
            kind: d.kind,
            affectsCreators: d.affectsCreators,
            changes: d.changes,
          })
          .returning();
        if (!row) throw new Error("proposal insert returned nothing");
        await audit(tx, {
          actorType: MEMBER,
          actorId: caller.user.id,
          action: "proposal.create",
          subjectType: "proposal",
          subjectId: id,
          details: { proposalId: id, kind: d.kind, affectsCreators: d.affectsCreators, keys: d.keys },
        });
        await proposalEvent(tx, row, now);
      }),
    );
    return viewOne(deps.db, id, caller.user.id, deps.now());
  }),

  update: os.coop.proposals.update.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        const p = await lockProposal(tx, input.id, caller.user.id, "update");
        check("edit", { proposal: p, callerId: caller.user.id, now });
        const d = await draftInput(tx, input);
        const [row] = await tx
          .update(proposals)
          .set({
            title: d.title,
            body: d.body,
            kind: d.kind,
            affectsCreators: d.affectsCreators,
            changes: d.changes,
            updatedAt: now,
          })
          .where(and(eq(proposals.id, p.id), eq(proposals.status, p.status)))
          .returning();
        if (!row) throw conflict("This proposal changed; reload and try again");
        await audit(tx, {
          actorType: MEMBER,
          actorId: caller.user.id,
          action: "proposal.update",
          subjectType: "proposal",
          subjectId: p.id,
          details: {
            proposalId: p.id,
            status: p.status,
            kind: d.kind,
            affectsCreators: d.affectsCreators,
            keys: d.keys,
          },
        });
        await proposalEvent(tx, row, now);
      }),
    );
    return viewOne(deps.db, input.id, caller.user.id, deps.now());
  }),

  submit: os.coop.proposals.submit.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    await transition(deps, input.id, caller.user.id, "submit");
    return viewOne(deps.db, input.id, caller.user.id, deps.now());
  }),

  withdraw: os.coop.proposals.withdraw.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    await transition(deps, input.id, caller.user.id, "withdraw");
    return viewOne(deps.db, input.id, caller.user.id, deps.now());
  }),

  comments: os.coop.proposals.comments.handler(async ({ context, input }) => {
    const { deps } = context;
    const callerId = context.caller?.user.id ?? null;
    const [p] = await deps.db
      .select({ status: proposals.status, authorId: proposals.authorId, discussionEndsAt: proposals.discussionEndsAt })
      .from(proposals)
      .where(eq(proposals.id, input.id));
    if (!p || !proposalVisibleTo(p, callerId)) throw notFound("Proposal not found");
    const cur = decodeCursor(input.cursor, isKeyCursor);
    // Oldest first: a discussion reads top to bottom.
    const rows = await deps.db
      .select()
      .from(proposalComments)
      .where(and(eq(proposalComments.proposalId, input.id), cur ? gt(proposalComments.id, cur.id) : undefined))
      .orderBy(asc(proposalComments.id))
      .limit(input.limit + 1);
    const people = await userPicks(
      deps.db,
      rows.map((r) => r.authorId),
    );
    return pageOf(
      rows,
      input.limit,
      (r) => ({
        id: r.id,
        author: people.get(r.authorId) ?? unknownUser(r.authorId),
        body: r.body,
        createdAt: iso(r.createdAt),
      }),
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
  }),

  comment: os.coop.proposals.comment.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const body = input.body.trim();
    if (!body) throw badRequest("The comment is empty");
    const id = uuidv7();
    const row = await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        // Share lock: the worker's transition waits for a comment in flight (the trigger reads it too).
        const p = await lockProposal(tx, input.id, caller.user.id, "share");
        check("comment", {
          proposal: p,
          callerId: caller.user.id,
          now,
          member: await isActiveMember(tx, caller.user.id),
        });
        const [c] = await tx
          .insert(proposalComments)
          .values({ id, proposalId: p.id, authorId: caller.user.id, body })
          .returning();
        if (!c) throw new Error("comment insert returned nothing");
        await audit(tx, {
          actorType: MEMBER,
          actorId: caller.user.id,
          action: "proposal.comment",
          subjectType: "proposal",
          subjectId: p.id,
          details: { proposalId: p.id, commentId: id },
        });
        await emit(tx, "coop.proposal.comment", null, { proposal_id: p.id, comment_id: id }, now);
        return c;
      }),
    );
    const people = await userPicks(deps.db, [caller.user.id]);
    return {
      id: row.id,
      author: people.get(caller.user.id) ?? unknownUser(caller.user.id),
      body: row.body,
      createdAt: iso(row.createdAt),
    };
  }),

  vote: os.coop.proposals.vote.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        // Lock order: the proposal before its votes. A share lock lets voters run concurrently
        // while the decision (an UPDATE of the proposal) waits for every vote in flight.
        const p = await lockProposal(tx, input.id, caller.user.id, "share");
        const [inElectorate] = await tx
          .select({ userId: proposalElectorate.userId })
          .from(proposalElectorate)
          .where(and(eq(proposalElectorate.proposalId, p.id), eq(proposalElectorate.userId, caller.user.id)));
        // The window is judged by the database clock, as the trigger and `voting_starts_at` are:
        // the API host's clock may be skewed against the database's.
        const [clock] = await tx.execute<{ ms: string }>(
          sql`select floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms`,
        );
        const dbNow = clock ? new Date(Number(clock.ms)) : now;
        check("vote", { proposal: p, callerId: caller.user.id, now: dbNow, inElectorate: inElectorate !== undefined });
        // One row per member (unique index): a change updates the caller's own row, never adds one.
        // The trigger checks the window and electorate again with the database clock.
        await tx
          .insert(votes)
          .values({ proposalId: p.id, userId: caller.user.id, choice: input.choice })
          .onConflictDoUpdate({ target: [votes.proposalId, votes.userId], set: { choice: input.choice } });
        // Secret ballot: ids only, never the choice.
        await audit(tx, {
          actorType: MEMBER,
          actorId: caller.user.id,
          action: "proposal.vote",
          subjectType: "proposal",
          subjectId: p.id,
          details: { proposalId: p.id },
        });
        await emit(tx, "coop.vote.cast", null, { proposal_id: p.id }, now);
      }),
    );
    return viewOne(deps.db, input.id, caller.user.id, deps.now());
  }),

  councilRespond: os.coop.proposals.councilRespond.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const body = input.body.trim();
    if (!body) throw badRequest("The response is empty");
    await withCoopErrors(() =>
      deps.db.transaction(async (tx) => {
        const now = deps.now();
        const p = await lockProposal(tx, input.id, caller.user.id, "share");
        const term = await currentCouncilTerm(tx);
        const [seat] = term
          ? await tx
              .select({ userId: schema.councilMembers.userId })
              .from(schema.councilMembers)
              .where(and(eq(schema.councilMembers.termId, term.id), eq(schema.councilMembers.userId, caller.user.id)))
          : [];
        const [existing] = await tx
          .select({ proposalId: councilResponses.proposalId })
          .from(councilResponses)
          .where(eq(councilResponses.proposalId, p.id));
        check("councilRespond", {
          proposal: p,
          callerId: caller.user.id,
          now,
          seated: term !== null && seat !== undefined,
          responded: existing !== undefined,
        });
        if (!term) throw notFound("No council is seated");
        await tx
          .insert(councilResponses)
          .values({ proposalId: p.id, termId: term.id, stance: input.stance, body, publishedById: caller.user.id });
        await audit(tx, {
          actorType: MEMBER,
          actorId: caller.user.id,
          action: "council.respond",
          subjectType: "proposal",
          subjectId: p.id,
          details: { proposalId: p.id, termId: term.id, stance: input.stance },
        });
        await emit(
          tx,
          "coop.council.response",
          null,
          { proposal_id: p.id, term_id: term.id, stance: input.stance },
          now,
        );
      }),
    );
    return viewOne(deps.db, input.id, caller.user.id, deps.now());
  }),
};

/** Author-driven transitions: open discussion, or withdraw before voting. */
async function transition(deps: Deps, id: string, callerId: string, action: "submit" | "withdraw") {
  await withCoopErrors(() =>
    deps.db.transaction(async (tx) => {
      const now = deps.now();
      const p = await lockProposal(tx, id, callerId, "update");
      check(action, { proposal: p, callerId, now });
      const to = action === "submit" ? ("discussion" as const) : ("withdrawn" as const);
      const [row] = await tx
        .update(proposals)
        .set({ status: to, updatedAt: now })
        .where(and(eq(proposals.id, p.id), eq(proposals.status, p.status)))
        .returning();
      if (!row) throw conflict("This proposal changed; reload and try again");
      await audit(tx, {
        actorType: MEMBER,
        actorId: callerId,
        action: action === "submit" ? "proposal.submit" : "proposal.withdraw",
        subjectType: "proposal",
        subjectId: p.id,
        details: { proposalId: p.id, from: p.status, to },
      });
      await proposalEvent(tx, row, now);
    }),
  );
}
