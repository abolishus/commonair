// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Closing a jury panel (`jury-close`, ADR 0038 §4 and §7), 14 days after its draw (or at once for
 * a named panel, the harness hook). In one transaction, with the panel row locked:
 *
 * 1. Cases that turned ineligible since sampling are withdrawn (`legal_hold`, `appeal`); they take
 *    no part in results or flags.
 * 2. The seed is revealed: the 0046 trigger accepts it only if it hashes to the commitment. A
 *    `jury.panel.reveal` audit row records it. After `closed_at` the trigger refuses every vote.
 * 3. Each remaining case whose `disagree` votes are more than half of its votes gets a
 *    `jury_flags` row and a `jury.case.flag` audit row, for staff re-review.
 *
 * Advisory only: nothing here (or anywhere in the jury) writes `moderation_cases`, `reports`,
 * account actions or statements of reasons. Results are computed on read by `jury.results`.
 */
import { schema, type Executor } from "@commonair/db";
import { systemAudit } from "@commonair/governance";
import { decryptSecret } from "@commonair/tokens";
import { and, eq, inArray, isNull, lte } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { PANEL_MS } from "./sample.ts";
import { JURY_SEED_PURPOSE } from "./seed.ts";
import { countVotes, majorityDisagrees, totalVotes } from "./votes.ts";

const { juryPanels, juryCases, juryVotes, juryFlags, moderationCases, reports, channels, legalHolds, appeals } = schema;

type Withdrawal = "legal_hold" | "appeal";

/** Sampled cases that may no longer be shown: an active legal hold on a party, or an open appeal. */
export async function ineligibleCases(tx: Executor, panelId: string): Promise<Map<string, Withdrawal>> {
  const cases = await tx
    .select({ id: juryCases.id, kind: juryCases.subjectKind, subjectId: juryCases.subjectId })
    .from(juryCases)
    .where(and(eq(juryCases.panelId, panelId), isNull(juryCases.withdrawnAt)));
  if (cases.length === 0) return new Map();
  const caseIds = cases.filter((c) => c.kind === "moderation_case").map((c) => c.subjectId);
  const reportIds = cases.filter((c) => c.kind === "report").map((c) => c.subjectId);
  const parties = new Map<string, string[]>();
  if (caseIds.length)
    for (const r of await tx
      .select({ id: moderationCases.id, userId: moderationCases.userId, ownerId: channels.ownerId })
      .from(moderationCases)
      .leftJoin(channels, eq(channels.id, moderationCases.channelId))
      .where(inArray(moderationCases.id, caseIds)))
      parties.set(
        r.id,
        [r.userId, r.ownerId].filter((x): x is string => x !== null),
      );
  if (reportIds.length)
    for (const r of await tx
      .select({
        id: reports.id,
        reporterId: reports.reporterId,
        subjectType: reports.subjectType,
        subjectId: reports.subjectId,
        ownerId: channels.ownerId,
      })
      .from(reports)
      .leftJoin(channels, eq(channels.id, reports.channelId))
      .where(inArray(reports.id, reportIds)))
      parties.set(
        r.id,
        [r.reporterId, r.ownerId, r.subjectType === "user" ? r.subjectId : null].filter((x): x is string => x !== null),
      );
  const holds = await tx
    .select({ userId: legalHolds.userId, caseId: legalHolds.caseId })
    .from(legalHolds)
    .where(isNull(legalHolds.releasedAt));
  const heldUsers = new Set(holds.map((h) => h.userId));
  const heldCases = new Set(holds.flatMap((h) => (h.caseId ? [h.caseId] : [])));
  const appealed = new Set(
    caseIds.length
      ? (
          await tx
            .select({ subjectId: appeals.subjectId })
            .from(appeals)
            .where(
              and(
                eq(appeals.subjectType, "moderation_case"),
                inArray(appeals.subjectId, caseIds),
                eq(appeals.status, "open"),
              ),
            )
        ).map((a) => a.subjectId)
      : [],
  );
  const out = new Map<string, Withdrawal>();
  for (const c of cases) {
    if (heldCases.has(c.subjectId) || (parties.get(c.subjectId) ?? []).some((u) => heldUsers.has(u)))
      out.set(c.id, "legal_hold");
    else if (appealed.has(c.subjectId)) out.set(c.id, "appeal");
  }
  return out;
}

export interface CloseCounts {
  closed: number;
  withdrawn: number;
  flagged: number;
}

/** Close one open panel; null when it is already closed (or gone). */
export async function closePanel(ctx: WorkerContext, panelId: string, now: Date): Promise<CloseCounts | null> {
  return ctx.db.transaction(async (tx) => {
    const [panel] = await tx
      .select()
      .from(juryPanels)
      .where(and(eq(juryPanels.id, panelId), isNull(juryPanels.closedAt)))
      .for("update");
    if (!panel) return null;

    const ineligible = await ineligibleCases(tx, panel.id);
    for (const [caseId, reason] of ineligible) {
      await tx
        .update(juryCases)
        .set({ withdrawnAt: now, withdrawnReason: reason })
        .where(and(eq(juryCases.id, caseId), isNull(juryCases.withdrawnAt)));
      await systemAudit(
        tx,
        {
          action: "jury.case.withdraw",
          subjectType: "jury_case",
          subjectId: caseId,
          reason,
          details: { panelId: panel.id },
        },
        now,
      );
    }

    const seed = await decryptSecret(ctx.webhooks.authSecret, JURY_SEED_PURPOSE, panel.sealedSeed);
    await tx.update(juryPanels).set({ seed, closedAt: now }).where(eq(juryPanels.id, panel.id));
    await systemAudit(
      tx,
      {
        action: "jury.panel.reveal",
        subjectType: "jury_panel",
        subjectId: panel.id,
        reason: "",
        details: { period: panel.period, seedCommitment: panel.seedCommitment, seed },
      },
      now,
    );

    const live = await tx
      .select({ id: juryCases.id })
      .from(juryCases)
      .where(and(eq(juryCases.panelId, panel.id), isNull(juryCases.withdrawnAt)));
    const votes = live.length
      ? await tx
          .select({ caseId: juryVotes.caseId, vote: juryVotes.vote })
          .from(juryVotes)
          .where(
            inArray(
              juryVotes.caseId,
              live.map((c) => c.id),
            ),
          )
      : [];
    let flagged = 0;
    for (const c of live) {
      const counts = countVotes(votes.filter((v) => v.caseId === c.id));
      if (!majorityDisagrees(counts)) continue;
      const [flag] = await tx
        .insert(juryFlags)
        .values({ caseId: c.id, createdAt: now })
        .onConflictDoNothing()
        .returning({ id: juryFlags.id });
      if (!flag) continue;
      flagged++;
      await systemAudit(
        tx,
        {
          action: "jury.case.flag",
          subjectType: "jury_case",
          subjectId: c.id,
          reason: "majority_disagree",
          details: { panelId: panel.id, flagId: flag.id, disagree: counts.disagree, votes: totalVotes(counts) },
        },
        now,
      );
    }
    return { closed: 1, withdrawn: ineligible.size, flagged };
  });
}

/** Close the named panel at once, or every open panel whose 14 days are up. */
export async function runClose(
  ctx: WorkerContext,
  data: { panelId?: string | undefined },
  now: Date = ctx.now(),
): Promise<CloseCounts> {
  const due = data.panelId
    ? [{ id: data.panelId }]
    : await ctx.db
        .select({ id: juryPanels.id })
        .from(juryPanels)
        .where(and(isNull(juryPanels.closedAt), lte(juryPanels.openedAt, new Date(now.getTime() - PANEL_MS))));
  const total: CloseCounts = { closed: 0, withdrawn: 0, flagged: 0 };
  for (const p of due) {
    const r = await closePanel(ctx, p.id, now);
    if (!r) continue;
    total.closed += r.closed;
    total.withdrawn += r.withdrawn;
    total.flagged += r.flagged;
  }
  if (total.closed > 0) ctx.logger.info("jury panels closed", { ...total });
  return total;
}

/** Called by each draw, so a lost delayed `jury-close` never leaves a panel open. */
export async function closeDuePanels(ctx: WorkerContext, now: Date): Promise<number> {
  return (await runClose(ctx, {}, now)).closed;
}
