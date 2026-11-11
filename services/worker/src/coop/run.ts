// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One run of each co-op job: the `@commonair/governance` step functions with the worker's clock
 * and logger, reduced to the counts of `CoopJobResult` (never ids, choices or names).
 */
import type { CoopJobResult } from "@commonair/contracts/internal";
import type { MembershipNotificationPayload } from "@commonair/contracts/notify";
import { type Database, schema } from "@commonair/db";
import {
  advanceElections,
  advanceProposals,
  recomputeCouncil,
  syncMemberships,
  type SyncResult,
} from "@commonair/governance";
import type { WorkerContext } from "../context.ts";
import { counts } from "./job.ts";
import { coopMetrics } from "./metrics.ts";

/** Proposals stepped per run (oldest deadline first); the rest wait for the next 15 s tick. */
export const PROPOSALS_PER_RUN = 100;

export async function runProposalsAdvance(ctx: WorkerContext): Promise<CoopJobResult> {
  const r = await advanceProposals(ctx.db, { limit: PROPOSALS_PER_RUN, logger: ctx.logger });
  const steps = {
    council_review: r.councilReview,
    voting: r.votingOpened,
    passed: r.passed,
    rejected: r.rejected,
    applied: r.applied,
    apply_refused: r.applyRefused,
    failed: r.failed,
  };
  for (const [step, n] of Object.entries(steps)) if (n > 0) coopMetrics.proposalSteps.add(n, { step });
  if (r.disagreements > 0) coopMetrics.tallyDisagreements.add(r.disagreements);
  return counts({ ...r });
}

/**
 * The dedupe key of a `membership` inbox row, the same as the API's (`services/api/src/coop/membership.ts`
 * `membershipNoticeKey`): a membership the payment webhook started is never announced twice.
 */
export const membershipNoticeKey = (kind: MembershipNotificationPayload["kind"], membershipId: string): string =>
  `${kind === "membership_started" ? "membership-started" : "membership-ended"}-${membershipId}`;

/**
 * The inbox notices for a sync's activations and lapses (`MembershipNotificationPayload`, enums
 * only). After the sync's own transaction, idempotent by dedupe key: a crash in between loses a
 * notice, never duplicates one, and the membership change itself is already committed.
 */
export async function membershipNotices(
  db: Database,
  r: Pick<SyncResult, "activated" | "lapsed">,
  now: Date,
): Promise<number> {
  const rows = [
    ...r.activated.map((c) => ({ c, kind: "membership_started" as const })),
    ...r.lapsed.map((c) => ({ c, kind: "membership_ended" as const })),
  ].map(({ c, kind }) => {
    const payload: MembershipNotificationPayload = { kind, basis: c.basis };
    return {
      userId: c.userId,
      type: "membership" as const,
      payload,
      dedupeKey: membershipNoticeKey(kind, c.membershipId),
      createdAt: now,
    };
  });
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(schema.notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: schema.notifications.id });
  return inserted.length;
}

export async function runMembershipSync(ctx: WorkerContext): Promise<CoopJobResult> {
  const now = ctx.now();
  const r = await syncMemberships(ctx.db, now, { logger: ctx.logger });
  await membershipNotices(ctx.db, r, now);
  const lapseRefused = r.refused.reduce((n, x) => n + x.wouldLapse, 0);
  if (r.activated.length) coopMetrics.memberships.add(r.activated.length, { change: "activated" });
  if (r.lapsed.length) coopMetrics.memberships.add(r.lapsed.length, { change: "lapsed" });
  if (lapseRefused) coopMetrics.memberships.add(lapseRefused, { change: "lapse_refused" });
  return counts({
    activated: r.activated.length,
    lapsed: r.lapsed.length,
    confirmed: r.confirmed,
    lapseRefused,
  });
}

export async function runCouncilRecompute(ctx: WorkerContext): Promise<CoopJobResult> {
  const r = await recomputeCouncil(ctx.db, ctx.now());
  if (r.created)
    ctx.logger.info("creator council seated", { termId: r.termId, reason: r.reason, seats: r.seats.length });
  return counts({ created: r.created, seats: r.seats.length });
}

export async function runElectionsAdvance(ctx: WorkerContext): Promise<CoopJobResult> {
  const r = await advanceElections(ctx.db, ctx.now(), { logger: ctx.logger });
  return counts({ ...r });
}
