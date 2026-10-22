// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The proposal lifecycle after submit (docs/testing/e5-selectors.md "Proposal flows"), run by the
 * worker's `proposals-advance` job:
 *
 *   discussion ──(ended)──▶ council_review (affects creators) ──(ended)──▶ voting
 *   discussion ──(ended)──▶ voting (otherwise)
 *   voting ──(ended)──▶ passed | rejected, with the `tallies` row
 *   passed ──▶ applied (every change written to governance_settings), or refused once
 *
 * Each step is one transaction that locks the proposal row first, re-checks that the step is
 * still due, makes the change and writes its audit row (actor `system`) and event. The triggers
 * (0001/0002/0021) re-check every step with the database clock and re-tally every decision, so
 * deadlines here are read from the database clock too: a worker whose clock runs ahead never
 * asks for a transition the database would refuse.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema, uuidv7, type Database, type Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { emitEvent, pgCode, systemAudit } from "./outbox.ts";
import { rulesFor, type ProposalKind, type ProposalStatus } from "./rules.ts";
import { loadSettings, ordinaryOf, protectionsOf, type SettingsMap } from "./settings.ts";
import { tally, type TallyReason, type TallyResult, type TALLY_RULES } from "./tally.ts";

const P = schema.proposals;

export type ProposalStep = "council_review" | "voting" | "decide" | "apply";

/** The fields of a proposal that decide its next step. */
export interface ProposalClock {
  status: ProposalStatus;
  affectsCreators: boolean;
  discussionEndsAt: Date | null;
  councilReviewEndsAt: Date | null;
  votingEndsAt: Date | null;
}

const before = (d: Date | null, now: Date) => d !== null && d.getTime() < now.getTime();

/**
 * The step due for `p` at `now`, or null. Deadlines must have strictly passed (the database
 * refuses a decision at or before `voting_ends_at`, and timestamps here are only
 * millisecond-precise). A `passed` proposal is always due to apply.
 */
export function nextStep(p: ProposalClock, now: Date): ProposalStep | null {
  switch (p.status) {
    case "discussion":
      if (!before(p.discussionEndsAt, now)) return null;
      return p.affectsCreators ? "council_review" : "voting";
    case "council_review":
      return before(p.councilReviewEndsAt, now) ? "voting" : null;
    case "voting":
      return before(p.votingEndsAt, now) ? "decide" : null;
    case "passed":
      return "apply";
    default:
      return null;
  }
}

/**
 * Length of the voting window: `governance.ordinary.votingSeconds`, raised to
 * `governance.protections.minVotingSeconds` for protected proposals (and never below the
 * ordinary minimum).
 */
export function votingSeconds(kind: ProposalKind, settings: SettingsMap): number {
  const o = ordinaryOf(settings);
  const min = kind === "protected" ? protectionsOf(settings).minVotingSeconds : o.minVotingSeconds;
  return Math.max(o.votingSeconds, min);
}

/**
 * Added to the window the worker asks for. `voting_ends_at` is computed from the database clock
 * in the UPDATE; the trigger reads the clock again a moment later for `voting_starts_at` and
 * refuses a window under the minimum, which a window of exactly the minimum would otherwise be.
 */
export const VOTING_MARGIN_SECONDS = 1;

export type DecisionRule = (typeof TALLY_RULES)[number] | "passed" | "timeline" | "snapshot";

const RULE_OF_REASON: Record<TallyReason, DecisionRule> = {
  passed: "passed",
  "proposal not found": "timeline",
  "voting never opened": "timeline",
  "voting has not ended": "timeline",
  "malformed rules": "snapshot",
  "member-wide quorum not met": "member_wide_quorum",
  "member-wide threshold not met": "member_wide_threshold",
  "streamer-class quorum not met": "streamer_class_quorum",
  "streamer-class majority not met": "streamer_class_majority",
};

/** The audit `rule` of a decision: the failing `TALLY_RULES` id, or `passed`. */
export const decisionRule = (r: Pick<TallyResult, "reason">): DecisionRule => RULE_OF_REASON[r.reason];

export interface AdvanceOptions {
  /** Proposals one run may step (oldest deadline first). Default 50. */
  limit?: number;
  logger?: Pick<Logger, "info" | "warn" | "error">;
  /**
   * Test seam: replaces the TypeScript tally, to prove that a tally the database disagrees with
   * records nothing. Never set in production code.
   */
  tallyFn?: typeof tally;
}

export interface AdvanceResult {
  councilReview: number;
  votingOpened: number;
  /** `vote_open` notifications written. */
  notified: number;
  passed: number;
  rejected: number;
  applied: number;
  applyRefused: number;
  /** Decisions the database refused because its tally differed (nothing was recorded). */
  disagreements: number;
  /** Steps that failed for any other reason (retried on the next run). */
  failed: number;
}

export const emptyAdvanceResult = (): AdvanceResult => ({
  councilReview: 0,
  votingOpened: 0,
  notified: 0,
  passed: 0,
  rejected: 0,
  applied: 0,
  applyRefused: 0,
  disagreements: 0,
  failed: 0,
});

type Row = Record<string, unknown>;
type Proposal = typeof P.$inferSelect;

/** The database clock (the one the triggers use), to the millisecond. */
async function dbNow(tx: Executor): Promise<Date> {
  const rows = (await tx.execute(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms`,
  )) as unknown as Row[];
  return new Date(Number(rows[0]?.ms));
}

const proposalEvent = (
  p: Pick<Proposal, "id" | "title" | "kind">,
  status: ProposalStatus,
  decision: { passed: boolean; reason: string } | null = null,
) => ({
  proposal_id: p.id,
  title: p.title,
  status,
  kind: p.kind,
  passed: decision?.passed ?? null,
  reason: decision?.reason ?? null,
});

/** Ids of proposals with a step due now, oldest deadline first. */
export async function dueProposals(db: Executor, limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    select p.id from proposals p
     where (p.status = 'discussion' and p.discussion_ends_at < clock_timestamp())
        or (p.status = 'council_review' and p.council_review_ends_at < clock_timestamp())
        or (p.status = 'voting' and p.voting_ends_at < clock_timestamp())
        or (p.status = 'passed' and not exists (
              select 1 from audit_log a
               where a.subject_type = 'proposal' and a.subject_id = p.id::text
                 and a.action = 'proposal.apply_refused'))
     order by case p.status
                when 'discussion' then p.discussion_ends_at
                when 'council_review' then p.council_review_ends_at
                when 'voting' then p.voting_ends_at
                else p.decided_at end asc nulls last, p.id
     limit ${limit}`)) as unknown as Row[];
  return rows.map((r) => String(r.id));
}

async function lockProposal(tx: Executor, id: string): Promise<Proposal | undefined> {
  const [row] = await tx.select().from(P).where(eq(P.id, id)).for("update");
  return row;
}

/** discussion → council_review. */
async function openCouncilReview(tx: Executor, p: Proposal, now: Date): Promise<void> {
  await tx.update(P).set({ status: "council_review" }).where(eq(P.id, p.id));
  await systemAudit(
    tx,
    {
      action: "proposal.council_review",
      subjectType: "proposal",
      subjectId: p.id,
      reason: "discussion period ended",
      details: { proposalId: p.id, kind: p.kind },
    },
    now,
  );
  await emitEvent(tx, "coop.proposal.update", proposalEvent(p, "council_review"), now);
}

/**
 * discussion | council_review → voting: freeze the rules, set the window, and notify every
 * member of the electorate the database built in the same statement.
 */
async function openVote(tx: Executor, p: Proposal, now: Date): Promise<number> {
  const settings = await loadSettings(tx);
  const rules = rulesFor(p.kind, settings, { affectsCreators: p.affectsCreators });
  const seconds = votingSeconds(p.kind, settings);
  const [opened] = await tx
    .update(P)
    .set({
      status: "voting",
      rules,
      votingEndsAt: sql`clock_timestamp() + make_interval(secs => ${seconds + VOTING_MARGIN_SECONDS}::float8)`,
    })
    .where(eq(P.id, p.id))
    .returning({ votingEndsAt: P.votingEndsAt });
  const electorate = await tx
    .select({ userId: schema.proposalElectorate.userId })
    .from(schema.proposalElectorate)
    .where(eq(schema.proposalElectorate.proposalId, p.id));
  if (electorate.length > 0) {
    await tx.insert(schema.notifications).values(
      electorate.map((e) => ({
        id: uuidv7(now.getTime()),
        userId: e.userId,
        type: "vote_open" as const,
        payload: { proposalId: p.id, kind: p.kind, votingEndsAt: opened?.votingEndsAt?.toISOString() ?? null },
        createdAt: now,
      })),
    );
  }
  await systemAudit(
    tx,
    {
      action: "proposal.open_vote",
      subjectType: "proposal",
      subjectId: p.id,
      reason: p.status === "council_review" ? "council review ended" : "discussion period ended",
      details: { proposalId: p.id, kind: p.kind, electorate: electorate.length, votingSeconds: seconds },
    },
    now,
  );
  await emitEvent(tx, "coop.proposal.update", proposalEvent(p, "voting"), now);
  return electorate.length;
}

/** voting → passed | rejected with the tallies row, from the frozen electorate and the votes. */
async function decide(tx: Executor, p: Proposal, clock: Date, now: Date, tallyFn: typeof tally): Promise<TallyResult> {
  const electorate = await tx
    .select({ userId: schema.proposalElectorate.userId, classes: schema.proposalElectorate.classes })
    .from(schema.proposalElectorate)
    .where(eq(schema.proposalElectorate.proposalId, p.id));
  const ballots = await tx
    .select({ userId: schema.votes.userId, choice: schema.votes.choice, castAt: schema.votes.castAt })
    .from(schema.votes)
    .where(eq(schema.votes.proposalId, p.id));
  const result = tallyFn(p.rules, electorate, ballots, { votingEndsAt: p.votingEndsAt, now: clock });
  const status = result.passed ? "passed" : "rejected";
  // The trigger re-tallies this transition and the tallies row; a disagreement raises.
  await tx.update(P).set({ status }).where(eq(P.id, p.id));
  await tx
    .insert(schema.tallies)
    .values({ proposalId: p.id, breakdown: result.breakdown, passed: result.passed, reason: result.reason });
  await systemAudit(
    tx,
    {
      action: "proposal.decide",
      subjectType: "proposal",
      subjectId: p.id,
      reason: "voting ended",
      details: { passed: result.passed, rule: decisionRule(result) },
    },
    now,
  );
  await emitEvent(tx, "coop.proposal.update", proposalEvent(p, status, result), now);
  return result;
}

/** Whether applying this proposal was already refused (it is never retried). */
async function applyRefusedBefore(tx: Executor, id: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.subjectType, "proposal"),
        eq(schema.auditLog.subjectId, id),
        eq(schema.auditLog.action, "proposal.apply_refused"),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** SQLSTATEs the governance triggers raise when they refuse a write. */
const REFUSALS = new Set(["42501", "23514", "P0001"]);

/**
 * passed → applied, all or nothing, inside a savepoint. When the database refuses a change (a
 * superseded decision, or a re-tally that no longer passes) the savepoint is rolled back, the
 * proposal stays `passed` and an `apply_refused` audit row marks it so it is not retried.
 */
async function apply(tx: Executor, p: Proposal, now: Date): Promise<"applied" | { refused: string }> {
  const keys = p.changes.map((c) => c.key);
  try {
    await tx.transaction(async (sp) => {
      for (const c of p.changes) {
        await sp
          .update(schema.governanceSettings)
          .set({ value: c.value, updatedByProposalId: p.id })
          .where(eq(schema.governanceSettings.key, c.key));
      }
      await sp.update(P).set({ status: "applied" }).where(eq(P.id, p.id));
    });
  } catch (err) {
    const code = pgCode(err);
    if (!code || !REFUSALS.has(code)) throw err;
    await systemAudit(
      tx,
      {
        action: "proposal.apply_refused",
        subjectType: "proposal",
        subjectId: p.id,
        reason: "the database refused the change (superseded since the vote opened, or no longer passing)",
        details: { proposalId: p.id, keys, code },
      },
      now,
    );
    return { refused: code };
  }
  await systemAudit(
    tx,
    {
      action: "proposal.apply",
      subjectType: "proposal",
      subjectId: p.id,
      reason: "passed proposal applied",
      details: { proposalId: p.id, keys },
    },
    now,
  );
  await emitEvent(tx, "coop.proposal.update", proposalEvent(p, "applied"), now);
  return "applied";
}

/** The SQL tally's reason for a proposal, for logging a disagreement (null if unavailable). */
async function sqlReason(db: Database, id: string): Promise<string | null> {
  try {
    const rows = (await db.execute(
      sql`select reason from commonair_governance_tally(${id}::uuid)`,
    )) as unknown as Row[];
    const reason = rows[0]?.reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

/**
 * Take the one step due for proposal `id`, if any, in one transaction. Safe to call
 * concurrently: the row lock serializes callers and the second one finds nothing due. The step
 * is judged and its audit row, event and notifications are stamped with the database clock read
 * after the row lock (the clock the triggers use), not with a caller's clock.
 */
export async function advanceProposal(
  db: Database,
  id: string,
  result: AdvanceResult = emptyAdvanceResult(),
  opts: Omit<AdvanceOptions, "limit"> = {},
): Promise<ProposalStep | null> {
  let attempted: ProposalStep | null = null;
  let tsReason: TallyReason | null = null;
  try {
    return await db.transaction(async (tx) => {
      const p = await lockProposal(tx, id);
      if (!p) return null;
      const now = await dbNow(tx);
      const step = nextStep(p, now);
      attempted = step;
      switch (step) {
        case null:
          return null;
        case "council_review":
          await openCouncilReview(tx, p, now);
          result.councilReview++;
          return step;
        case "voting":
          result.notified += await openVote(tx, p, now);
          result.votingOpened++;
          return step;
        case "decide": {
          const clock = await dbNow(tx);
          const r = await decide(tx, p, clock, now, (...args) => {
            const out = (opts.tallyFn ?? tally)(...args);
            tsReason = out.reason;
            return out;
          });
          if (r.passed) result.passed++;
          else result.rejected++;
          return step;
        }
        case "apply": {
          if (await applyRefusedBefore(tx, id)) return null;
          const out = await apply(tx, p, now);
          if (out === "applied") result.applied++;
          else {
            result.applyRefused++;
            opts.logger?.warn("governance: a passed proposal could not be applied", {
              proposalId: id,
              code: out.refused,
            });
          }
          return step;
        }
      }
    });
  } catch (err) {
    const code = pgCode(err);
    if (attempted === "decide" && code !== undefined && REFUSALS.has(code)) {
      // The TS and SQL tallies disagree: a bug. Nothing was recorded; log both reasons.
      result.disagreements++;
      opts.logger?.error("governance: tally disagrees with the database; nothing recorded", {
        proposalId: id,
        tsReason,
        sqlReason: await sqlReason(db, id),
        code,
      });
    } else {
      result.failed++;
      opts.logger?.error("governance: proposal step failed", { proposalId: id, step: attempted, code });
    }
    return null;
  }
}

/**
 * One run of `proposals-advance`: step every due proposal once, oldest deadline first, at most
 * `limit` of them. A failing proposal is counted and logged and never blocks the others.
 */
export async function advanceProposals(db: Database, opts: AdvanceOptions = {}): Promise<AdvanceResult> {
  const result = emptyAdvanceResult();
  for (const id of await dueProposals(db, opts.limit ?? 50)) {
    await advanceProposal(db, id, result, opts);
  }
  return result;
}
