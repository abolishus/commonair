// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Re-scoring an overturned exclusion group (ADR 0014 decision 4, batch 6 decision (m), batch 7
 * decision (g)). The scorer never revisits an ended session past finalize, and the Valkey evidence
 * has expired by then, so an overturned group is re-scored here **from stored data**
 * (`verdict_reasons`, the session's heartbeat counter, its `integrity_flags` scores and the
 * `integrity.thresholds` setting in force):
 *
 *   - covered: ended sessions of the broadcast (a session still open on an ended broadcast ended
 *     with it; on a live broadcast only closed ones), excluded, started at or before the decision, whose
 *     category (`exclusionCategoryOf`, the rollup's attribution) is the appealed one. Nothing else
 *     is read for update or written: not later sessions, not other broadcasts, not sessions whose
 *     first reason is another category (even if they also carry this category's signal);
 *   - the category's signal codes are dropped (for `other`, the codes no current signal knows);
 *   - the signals left are weighed as the scorer weighs them: the noisy-OR of their flagged scores
 *     against `sessionExcludeScore`, with the scorer's own rule (`score > threshold` excludes).
 *     Still over it: `excluded`, with the reduced reasons (the session moves to that group) and
 *     `allowed_on_appeal`. At or under it (or nothing left): `verified`, or `pending` while
 *     `insufficient_heartbeats` (or too few heartbeats) or `media_unconfirmed` remains, with the
 *     signals left still listed (as the scorer lists what it noticed on a verified session) and
 *     `allowed_on_appeal` appended;
 *   - fail closed: a signal left with no flag to weigh it, or a code no current signal knows (an
 *     admin decision, a retired code) left by another category's overturn, keeps the session
 *     excluded. Neither is a score this rule can weigh.
 *
 * The flags of the dropped signals get the `allowed` decision (as an admin "clear flag" does), each
 * changed session an `integrity.session.restore` / `integrity.session.rescore` audit row (ids,
 * enums and the threshold only), and when anything changed the `integrity.sessions.rescored`
 * outbox event, all in the caller's transaction: the worker then re-runs the rollup, whose
 * `analytics.rollup.ready` drives the attestation re-check (a `supersede` entry when the figures
 * moved). A second overturn of the same group finds nothing left in it and changes nothing.
 */
import { and, eq, inArray, isNotNull, lte, ne, notInArray, sql } from "drizzle-orm";
import type { ExclusionCategory } from "@commonair/contracts/enums";
import { EVENTS } from "@commonair/contracts/events";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import { categoryOfReason, exclusionCategoryOf, SIGNAL_CATEGORIES } from "./constants.ts";
import { MIN_HEARTBEATS_TO_VERIFY } from "./score.ts";
import { noisyOr } from "./signals/combine.ts";
import { loadThresholds } from "./thresholds.ts";
import {
  ALLOWED_ON_APPEAL,
  FETCH_UNJUDGED,
  INSUFFICIENT_HEARTBEATS,
  MEDIA_UNCONFIRMED,
  SESSION_SIGNALS,
  type SessionSignalCode,
  type Verdict,
} from "./types.ts";

/** Reason codes that are not exclusion signals: they never keep a session excluded. */
const NON_SIGNAL_REASONS: ReadonlySet<string> = new Set([
  ALLOWED_ON_APPEAL,
  FETCH_UNJUDGED,
  INSUFFICIENT_HEARTBEATS,
  MEDIA_UNCONFIRMED,
]);

/** The signal codes an overturn of `category` allows (none for `other`: it drops unknown codes). */
export function categorySignals(category: ExclusionCategory): SessionSignalCode[] {
  return SESSION_SIGNALS.filter((c) => SIGNAL_CATEGORIES[c] === category);
}

/** Whether an overturn of `category` drops this reason code. */
function dropped(reason: string, category: ExclusionCategory): boolean {
  if (NON_SIGNAL_REASONS.has(reason)) return false;
  const c = categoryOfReason(reason);
  // A code no current signal knows (an admin decision, a retired code) is what `other` means.
  return c === null ? category === "other" : c === category;
}

/** The stored facts of one session the pure re-score reads. */
export interface StoredVerdict {
  verdict: Verdict;
  reasons: readonly string[] | null;
  startedAt: Date;
  endedAt: Date | null;
  heartbeats: number;
}

/** What the signals left are weighed against: the live scorer's threshold and the stored flag scores. */
export interface RescoreWeights {
  /** `integrity.thresholds.sessionExcludeScore` in force. */
  threshold: number;
  /** The session's strongest flagged score per signal code. */
  flagScores: ReadonlyMap<string, number>;
}

export interface Rescored {
  verdict: Verdict;
  reasons: string[];
  /** The reason codes the overturn dropped (their flags get the `allowed` decision). */
  dropped: string[];
  /** The noisy-OR of the signals left: the session's stored score. */
  score: number;
}

/**
 * The live scorer's exclusion rule (`scoreSession`: a score above `sessionExcludeScore` excludes).
 * CONTRACT-REQUEST: `score.ts` should export this predicate and use it itself, so the two cannot
 * drift; until then the parity test in `tests/rescore.test.ts` runs both on the same scores.
 */
export const overThreshold = (score: number, threshold: number): boolean => score > threshold;

/**
 * Whether an overturn of `category` decided at `decidedAt` covers this session: excluded, ended,
 * started at or before the decision, and in that category.
 */
export function coveredBy(s: StoredVerdict, category: ExclusionCategory, decidedAt: Date): boolean {
  if (s.verdict !== "excluded" || s.endedAt === null) return false;
  if (s.startedAt.getTime() > decidedAt.getTime()) return false;
  return exclusionCategoryOf(s.reasons ?? []) === category;
}

/**
 * The pure re-score of one session for an overturn of `category` decided at `decidedAt`, or null
 * when the overturn does not cover it (`coveredBy`).
 */
export function rescoreStoredSession(
  s: StoredVerdict,
  category: ExclusionCategory,
  decidedAt: Date,
  weights: RescoreWeights,
): Rescored | null {
  if (!coveredBy(s, category, decidedAt)) return null;
  const reasons = s.reasons ?? [];
  const gone = reasons.filter((r) => dropped(r, category));
  const left = reasons.filter((r) => !dropped(r, category));
  const signals = left.filter((r) => !NON_SIGNAL_REASONS.has(r));
  const score = rescoredScore(signals, weights.flagScores);
  // Fail closed on what cannot be weighed: a code no current signal knows, or a signal with no flag.
  const unweighable = signals.some((r) => categoryOfReason(r) === null || !weights.flagScores.has(r));
  // The scorer's order: signals (strongest first), `allowed_on_appeal`, `fetch_unjudged`, then the
  // pending reason.
  const out = [...signals, ALLOWED_ON_APPEAL];
  if (left.includes(FETCH_UNJUDGED)) out.push(FETCH_UNJUDGED);
  const result = (verdict: Verdict, pendingReason?: string): Rescored => ({
    verdict,
    reasons: pendingReason ? [...out, pendingReason] : out,
    dropped: gone,
    score,
  });
  if (unweighable || overThreshold(score, weights.threshold)) return result("excluded");
  if (left.includes(INSUFFICIENT_HEARTBEATS) || s.heartbeats < MIN_HEARTBEATS_TO_VERIFY)
    return result("pending", INSUFFICIENT_HEARTBEATS);
  // As in the scorer, an allowed `fetch_pattern` also lifts the media hold.
  if (left.includes(MEDIA_UNCONFIRMED) && !gone.includes("fetch_pattern")) return result("pending", MEDIA_UNCONFIRMED);
  return result("verified");
}

/**
 * The noisy-OR of the strongest flagged score of each signal left (a signal with no flag adds
 * nothing), so a session with no signal left scores 0.
 */
export function rescoredScore(reasons: readonly string[], flagScores: ReadonlyMap<string, number>): number {
  return noisyOr(reasons.flatMap((r) => (flagScores.has(r) ? [flagScores.get(r) as number] : [])));
}

export interface RescoreExclusionGroupInput {
  broadcastId: string;
  category: ExclusionCategory;
  /** The overturn's decision time; sessions started after it are never touched. */
  decidedAt: Date;
  /** Who decided (the flags' `decided_by_id`); null for a system decision. */
  decidedById?: string | null;
  /** The overturned appeal, named in the audit rows. */
  appealId?: string | null;
}

export interface RescoreExclusionGroupResult {
  /** Sessions whose verdict or reasons changed. */
  rescored: number;
  /** Of those, now verified or pending (what is left is at or under the threshold). */
  restored: number;
}

/** Runs inside the caller's transaction (`appeals.resolve`). */
export async function rescoreExclusionGroup(
  tx: Executor,
  input: RescoreExclusionGroupInput,
): Promise<RescoreExclusionGroupResult> {
  const ps = schema.playbackSessions;
  const [b] = await tx
    .select({ channelId: schema.broadcasts.channelId, endedAt: schema.broadcasts.endedAt })
    .from(schema.broadcasts)
    .where(eq(schema.broadcasts.id, input.broadcastId));
  if (!b) return { rescored: 0, restored: 0 };
  const broadcastEnded = b.endedAt;
  // Locked, so a concurrent scorer pass or a second overturn waits for this one.
  const candidates = await tx
    .select({
      id: ps.id,
      verdict: ps.verdict,
      reasons: ps.verdictReasons,
      startedAt: ps.startedAt,
      endedAt: ps.endedAt,
      heartbeats: ps.heartbeats,
    })
    .from(ps)
    .where(
      and(
        eq(ps.broadcastId, input.broadcastId),
        eq(ps.verdict, "excluded"),
        broadcastEnded === null ? isNotNull(ps.endedAt) : undefined,
        lte(ps.startedAt, input.decidedAt),
      ),
    )
    .orderBy(ps.id)
    .for("update");
  // A session still open on an ended broadcast (the stale-session job has not closed it yet)
  // watches nothing more of it: it ended with the broadcast.
  const inGroup = candidates
    .map((c) => ({ ...c, endedAt: c.endedAt ?? broadcastEnded }))
    .filter((c) => coveredBy(c, input.category, input.decidedAt));
  if (inGroup.length === 0) return { rescored: 0, restored: 0 };
  const ids = inGroup.map((c) => c.id);

  const flags = schema.integrityFlags;
  const flagRows = await tx
    .select({ sessionId: flags.subjectId, signal: flags.signal, score: sql<number>`max(${flags.score})` })
    .from(flags)
    .where(and(eq(flags.subjectType, "session"), inArray(flags.subjectId, ids)))
    .groupBy(flags.subjectId, flags.signal);
  const scores = new Map<string, Map<string, number>>();
  for (const f of flagRows) {
    const m = scores.get(f.sessionId) ?? new Map<string, number>();
    m.set(f.signal, Number(f.score));
    scores.set(f.sessionId, m);
  }
  // The live scorer's threshold, read where and as the scorer reads it (decision (g)).
  const { sessionExcludeScore: threshold } = await loadThresholds(tx);
  const covered = inGroup.flatMap((c) => {
    const r = rescoreStoredSession(c, input.category, input.decidedAt, {
      threshold,
      flagScores: scores.get(c.id) ?? new Map(),
    });
    return r ? [{ id: c.id, ...r }] : [];
  });

  let restored = 0;
  for (const c of covered) {
    if (c.verdict !== "excluded") restored++;
    await tx
      .update(ps)
      .set({ verdict: c.verdict, verdictReasons: c.reasons, score: c.score })
      .where(and(eq(ps.id, c.id), eq(ps.verdict, "excluded")));
  }

  // The dropped signals' flags on the covered sessions are allowed by this decision.
  const signals = categorySignals(input.category);
  await tx
    .update(flags)
    .set({ decision: "allowed", decidedById: input.decidedById ?? null, decidedAt: input.decidedAt })
    .where(
      and(
        eq(flags.subjectType, "session"),
        inArray(flags.subjectId, ids),
        input.category === "other" ? notInArray(flags.signal, [...SESSION_SIGNALS]) : inArray(flags.signal, signals),
        ne(flags.decision, "allowed"),
      ),
    );

  await tx.insert(schema.auditLog).values(
    covered.map((c) => ({
      actorType: "system" as const,
      actorId: null,
      action: c.verdict === "excluded" ? "integrity.session.rescore" : "integrity.session.restore",
      subjectType: "session",
      subjectId: c.id,
      channelId: b.channelId,
      reason: ALLOWED_ON_APPEAL,
      details: {
        appealId: input.appealId ?? null,
        broadcastId: input.broadcastId,
        category: input.category,
        previousVerdict: "excluded",
        verdict: c.verdict,
        reasons: c.reasons,
        score: c.score,
        threshold,
      },
    })),
  );

  const def = EVENTS["integrity.sessions.rescored"];
  const payload = def.payload.parse({
    broadcast_id: input.broadcastId,
    channel_id: b.channelId,
    sessions: covered.length,
  }) as Record<string, unknown>;
  await tx.insert(schema.events).values({
    id: uuidv7(input.decidedAt.getTime()),
    type: "integrity.sessions.rescored",
    version: def.version,
    channelId: b.channelId,
    payload,
    occurredAt: input.decidedAt,
  });
  return { rescored: covered.length, restored };
}
