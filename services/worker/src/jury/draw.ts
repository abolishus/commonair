// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The monthly jury draw (`jury-draw`, ADR 0038 §4, decision (s)):
 *
 * 1. While `jury.enabled` is false, nothing is drawn.
 * 2. A fresh seed is committed first, in its own transaction: `jury_panels.seed_commitment` and a
 *    `jury.panel.commit` audit row are written and committed before anything is selected. The seed
 *    itself is kept sealed (`encryptSecret`, purpose `jury-seed`) until `jury-close` reveals it.
 * 3. In one transaction, with the panel row locked: seats are drawn over the eligible pool sorted
 *    by user id (domain `jury/seats`), cases over the eligible candidates sorted by key (domain
 *    `jury/cases`), each case gets its per-panel pseudonyms, and `jury.panel.drawn` plus a
 *    `jury.panel.draw` audit row are written. A row the 0046 triggers refuse (an opt-out or a
 *    legal hold landing meanwhile) is skipped in its own savepoint.
 * 4. `jury-close` is queued for 14 days later.
 *
 * Same seed and same pool give the same seats and cases (`draw` is deterministic). One panel per
 * UTC month: a second run in the month finds it drawn and does nothing. Audit rows hold ids and
 * counts only.
 */
import { JURY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { schema, type Executor } from "@commonair/db";
import { commit, drawEntries, newSalt, newSeed } from "@commonair/draw";
import { emitEvent, pgCode, systemAudit } from "@commonair/governance";
import { decryptSecret, encryptSecret } from "@commonair/tokens";
import { and, eq } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { loadCandidates, loadPool, poolEntries, type CandidateRow } from "./candidates.ts";
import { closeDuePanels } from "./close.ts";
import { caseMap, panelPseudonyms } from "./pseudonyms.ts";
import {
  CASE_DOMAIN,
  PANEL_MS,
  SEAT_DOMAIN,
  candidateEntries,
  candidateKey,
  panelPeriod,
  parseCandidateKey,
} from "./sample.ts";
import { JURY_SEED_PURPOSE } from "./seed.ts";
import { readJurySettings } from "./settings.ts";

const { juryPanels, jurySeats, juryCases, auditLog } = schema;

export { JURY_SEED_PURPOSE } from "./seed.ts";

export const juryCloseJobId = (panelId: string) => `${JURY_JOBS.close}-${panelId}`;

type PanelRow = typeof juryPanels.$inferSelect;

export interface DrawSelection {
  seats: string[];
  /** Candidate keys, in drawn order. */
  cases: string[];
  pool: number;
  candidates: number;
}

/** The pure part of the draw: same seed, pool and candidates → same seats and cases. */
export async function selectPanel(
  seed: string,
  pool: readonly string[],
  candidates: readonly string[],
  sizes: { panelSize: number; casesPerPanel: number },
): Promise<DrawSelection> {
  const seats = (await drawEntries(seed, pool, sizes.panelSize, SEAT_DOMAIN)).sort();
  const cases = await drawEntries(seed, candidates, sizes.casesPerPanel, CASE_DOMAIN);
  return { seats, cases, pool: pool.length, candidates: candidates.length };
}

/** True once the panel's selection transaction committed (its audit row exists). */
async function alreadyDrawn(tx: Executor, panelId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "jury.panel.draw"),
        eq(auditLog.subjectType, "jury_panel"),
        eq(auditLog.subjectId, panelId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Step 2: this month's panel with its commitment, created (and committed) when missing. */
async function committedPanel(ctx: WorkerContext, period: string, now: Date): Promise<PanelRow> {
  const existing = async () => (await ctx.db.select().from(juryPanels).where(eq(juryPanels.period, period)))[0];
  const found = await existing();
  if (found) return found;
  const seed = newSeed();
  const seedCommitment = await commit(seed);
  const sealedSeed = await encryptSecret(ctx.webhooks.authSecret, JURY_SEED_PURPOSE, seed);
  await ctx.db.transaction(async (tx) => {
    const [p] = await tx
      .insert(juryPanels)
      .values({ period, seedCommitment, sealedSeed, openedAt: now })
      .onConflictDoNothing()
      .returning({ id: juryPanels.id });
    if (!p) return; // Another run committed this month's panel first.
    await systemAudit(
      tx,
      {
        action: "jury.panel.commit",
        subjectType: "jury_panel",
        subjectId: p.id,
        reason: "",
        details: { period, seedCommitment },
      },
      now,
    );
  });
  const after = await existing();
  if (!after) throw new Error("jury panel missing after commit");
  return after;
}

/** SQLSTATEs the 0046 jury triggers refuse a row with: check_violation, foreign_key_violation. */
const TRIGGER_REFUSALS: ReadonlySet<string> = new Set(["23514", "23503"]);

/**
 * Insert in a savepoint: a row the 0046 triggers refuse is skipped, not fatal. Anything else (a
 * dropped connection, a serialization failure) aborts the draw, so the panel is not committed
 * short and a rerun can still draw it.
 */
export async function tryInsert(tx: Executor, insert: (sp: Executor) => Promise<unknown>): Promise<boolean> {
  try {
    await tx.transaction(async (sp) => {
      await insert(sp);
    });
    return true;
  } catch (err) {
    const code = pgCode(err);
    if (code !== undefined && TRIGGER_REFUSALS.has(code)) return false;
    throw err;
  }
}

export type DrawCounts = Record<string, number>;

export async function runDraw(ctx: WorkerContext, now: Date = ctx.now()): Promise<DrawCounts> {
  const closed = await closeDuePanels(ctx, now);
  const settings = await readJurySettings(ctx.db);
  if (!settings.enabled) return { disabled: 1, closed };

  const period = panelPeriod(now);
  const panel = await committedPanel(ctx, period, now);
  if (panel.closedAt !== null) return { exists: 1, closed };
  const seed = await decryptSecret(ctx.webhooks.authSecret, JURY_SEED_PURPOSE, panel.sealedSeed);

  const result = await ctx.db.transaction(async (tx): Promise<DrawCounts | null> => {
    // Serialize concurrent runs on the panel row, then check inside the lock.
    await tx.select({ id: juryPanels.id }).from(juryPanels).where(eq(juryPanels.id, panel.id)).for("update");
    if (await alreadyDrawn(tx, panel.id)) return null;

    const pool = poolEntries(await loadPool(tx), now);
    const candidates = await loadCandidates(tx, now);
    const entries = candidateEntries(candidates, now);
    const picked = await selectPanel(seed, pool, entries, settings);
    const byKey = new Map<string, CandidateRow>(candidates.map((c) => [candidateKey(c), c]));
    const rows = picked.cases.map((k) => byKey.get(k)).filter((c): c is CandidateRow => c !== undefined);
    // A fresh salt per panel, used here once and never stored.
    const names = await panelPseudonyms(
      newSalt(),
      rows.map((c) => c.subjectPartyId),
    );

    let seats = 0;
    for (const userId of picked.seats)
      if (await tryInsert(tx, (sp) => sp.insert(jurySeats).values({ panelId: panel.id, userId }))) seats++;
    let cases = 0;
    for (const c of rows) {
      const { kind, id } = parseCandidateKey(candidateKey(c));
      const ok = await tryInsert(tx, (sp) =>
        sp.insert(juryCases).values({
          panelId: panel.id,
          subjectKind: kind,
          subjectId: id,
          ruleRef: c.ruleRef,
          pseudonymMap: caseMap(names, c.subjectPartyId),
        }),
      );
      if (ok) cases++;
    }
    await emitEvent(tx, "jury.panel.drawn", { panel_id: panel.id }, now);
    await systemAudit(
      tx,
      {
        action: "jury.panel.draw",
        subjectType: "jury_panel",
        subjectId: panel.id,
        reason: "",
        details: { period, seats, cases, pool: picked.pool, candidates: picked.candidates },
      },
      now,
    );
    return {
      drawn: 1,
      seats,
      cases,
      pool: picked.pool,
      candidates: picked.candidates,
      refused: picked.seats.length - seats + (rows.length - cases),
    };
  });
  if (result === null) return { exists: 1, closed };

  const closesAt = panel.openedAt.getTime() + PANEL_MS;
  await ctx.enqueue(
    QUEUES.jury,
    JURY_JOBS.close,
    { panelId: panel.id },
    { jobId: juryCloseJobId(panel.id), delayMs: Math.max(0, closesAt - now.getTime()) },
  );
  ctx.logger.info("jury panel drawn", { panelId: panel.id, ...result });
  return { ...result, closed };
}
