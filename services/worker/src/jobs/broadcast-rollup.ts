// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The per-broadcast audience rollup (W2-rollup-analytics, ADR 0014 decisions 1, 3; batch 6
 * decision (k)). Enqueued by the outbox relay `AUDIENCE_SETTLE_SECONDS` after `stream.offline`
 * (`reason: "offline"`), at once on `integrity.sessions.rescored` (`"rescore"`), and by the API test
 * hook (`"test"`, with `settleSeconds`). Re-runnable: one transaction replaces the broadcast's rows
 * and emits `analytics.rollup.ready`, which starts the attestation job.
 *
 * What it writes is counts, seconds, bytes and categories only: never a user id, a signal code or
 * a threshold. Rehearsals are skipped outright (decision (f); the 0043 triggers refuse them too).
 * A broadcast whose per-minute rows aged out (`ANALYTICS_RULES.minuteRetentionDays`) is final and
 * never re-rolled: attestations cite it.
 */
import { ANALYTICS_RULES, DELIVERY_SOURCES, type ExclusionCategory } from "@commonair/contracts/enums";
import {
  ANALYTICS_JOBS,
  type AnalyticsJobResult,
  BroadcastRollupJob,
  QUEUES,
  type BroadcastRollupJob as RollupData,
} from "@commonair/contracts/internal";
import { type InfraCostModel, costModelEnv, loadEnv } from "@commonair/config";
import { type Executor, lockLegalHold, schema } from "@commonair/db";
import { AUDIENCE_SETTLE_SECONDS, FETCH_UNJUDGED, exclusionCategoryOf } from "@commonair/integrity";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { emit } from "../moderation/records.ts";
import { defineJob } from "../runtime/registry.ts";

type Source = (typeof DELIVERY_SOURCES)[number];
type BySource = Partial<Record<Source, number>>;
type ByCategory = Partial<Record<ExclusionCategory, number>>;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Rows per insert statement (well under Postgres' 65,535 bind parameters at 8 columns). */
const INSERT_CHUNK = 1000;
/** Broadcasts whose per-minute rows one housekeeping pass deletes. */
const PURGE_BATCH = 200;

// ------------------------------------------------------------------------------- pure helpers

/** What the rollup reads of one playback session. */
export interface RollupSession {
  startedAt: Date;
  endedAt: Date | null;
  assignedSource: Source;
  verdict: "pending" | "verified" | "excluded";
  verdictReasons: readonly string[];
  scoredAt: Date | null;
}

export type SessionClass =
  | { kind: "verified" }
  | { kind: "unverified" }
  | { kind: "excluded"; category: ExclusionCategory };

/**
 * ADR 0014 decision 7: verified means gate-eligible (`gateEligible` plus `scored_at`, the SQL
 * `GATE_ELIGIBLE`); pending and fetch-unjudged sessions are unverified, never verified and never
 * excluded. An excluded session's category is its first reason's (reasons are sorted by score).
 */
export function classifySession(s: Pick<RollupSession, "verdict" | "verdictReasons" | "scoredAt">): SessionClass {
  if (s.verdict === "excluded") return { kind: "excluded", category: exclusionCategoryOf(s.verdictReasons) };
  if (s.verdict === "verified" && s.scoredAt !== null && !s.verdictReasons.includes(FETCH_UNJUDGED))
    return { kind: "verified" };
  return { kind: "unverified" };
}

/**
 * The part of a session inside the broadcast, in epoch ms: a session still open (no `endedAt`) is
 * clipped at the broadcast end, and so is anything before the start or after the end. Empty
 * (`end <= start`) for a zero-length session or one wholly outside the broadcast.
 */
export function sessionWindow(
  s: Pick<RollupSession, "startedAt" | "endedAt">,
  b: { startedAt: Date; endedAt: Date },
): { start: number; end: number } {
  const start = Math.max(s.startedAt.getTime(), b.startedAt.getTime());
  const end = Math.min((s.endedAt ?? b.endedAt).getTime(), b.endedAt.getTime());
  return { start, end: Math.max(start, end) };
}

/** Whole seconds of a window (floored per session, so totals are sums of per-session figures). */
export const windowSeconds = (w: { start: number; end: number }) => Math.floor((w.end - w.start) / 1000);

/** Every minute (epoch ms, floored to the UTC minute) the window overlaps; none when it is empty. */
export function minutesOf(w: { start: number; end: number }): number[] {
  if (w.end <= w.start) return [];
  const out: number[] = [];
  // The minute holding the last instant before `end`: a window ending exactly on a minute boundary
  // does not touch the next minute.
  for (let m = Math.floor(w.start / MINUTE_MS) * MINUTE_MS; m < w.end; m += MINUTE_MS) out.push(m);
  return out;
}

export interface MinuteRow {
  minute: Date;
  verified: number;
  unverified: number;
  excluded: number;
  excludedByCategory: ByCategory;
  verifiedBySource: BySource;
  rawBySource: BySource;
}

export interface RollupTotals {
  durationSeconds: number;
  sessions: number;
  peakVerifiedConcurrent: number;
  verifiedViewerSeconds: number;
  unverifiedViewerSeconds: number;
  excludedViewerSeconds: number;
  excludedSecondsByCategory: ByCategory;
  excludedSessionsByCategory: ByCategory;
  verifiedSecondsBySource: BySource;
}

const bump = <K extends string>(m: Partial<Record<K, number>>, k: K, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};

/**
 * Bucket every session into each minute it overlaps and total its seconds. A minute's figures are
 * the sessions active at some point in it (so a short session that ended and one that started in
 * the same minute both count there). The peak is not read off those buckets, which would count a
 * reconnect twice: it is the most verified sessions open at one instant (`peakConcurrent`).
 *
 * A session with less than one whole second inside the broadcast (zero length, or wholly outside)
 * counts nowhere: not in `sessions`, not in a group's size, not in a minute. Otherwise a burst of
 * instant reconnects could make up a group of 5 on its own.
 */
export function rollUp(
  b: { startedAt: Date; endedAt: Date },
  sessions: readonly RollupSession[],
): { minutes: MinuteRow[]; totals: RollupTotals } {
  const byMinute = new Map<number, MinuteRow>();
  const totals: RollupTotals = {
    durationSeconds: Math.max(0, Math.floor((b.endedAt.getTime() - b.startedAt.getTime()) / 1000)),
    sessions: 0,
    peakVerifiedConcurrent: 0,
    verifiedViewerSeconds: 0,
    unverifiedViewerSeconds: 0,
    excludedViewerSeconds: 0,
    excludedSecondsByCategory: {},
    excludedSessionsByCategory: {},
    verifiedSecondsBySource: {},
  };
  const verifiedWindows: { start: number; end: number }[] = [];
  for (const s of sessions) {
    const w = sessionWindow(s, b);
    const seconds = windowSeconds(w);
    if (seconds === 0) continue;
    totals.sessions++;
    const c = classifySession(s);
    if (c.kind === "verified") {
      verifiedWindows.push(w);
      totals.verifiedViewerSeconds += seconds;
      bump(totals.verifiedSecondsBySource, s.assignedSource, seconds);
    } else if (c.kind === "unverified") totals.unverifiedViewerSeconds += seconds;
    else {
      totals.excludedViewerSeconds += seconds;
      bump(totals.excludedSecondsByCategory, c.category, seconds);
      bump(totals.excludedSessionsByCategory, c.category);
    }
    for (const m of minutesOf(w)) {
      let row = byMinute.get(m);
      if (!row) {
        row = {
          minute: new Date(m),
          verified: 0,
          unverified: 0,
          excluded: 0,
          excludedByCategory: {},
          verifiedBySource: {},
          rawBySource: {},
        };
        byMinute.set(m, row);
      }
      bump(row.rawBySource, s.assignedSource);
      if (c.kind === "verified") {
        row.verified++;
        bump(row.verifiedBySource, s.assignedSource);
      } else if (c.kind === "unverified") row.unverified++;
      else {
        row.excluded++;
        bump(row.excludedByCategory, c.category);
      }
    }
  }
  const minutes = [...byMinute.values()].sort((x, y) => x.minute.getTime() - y.minute.getTime());
  totals.peakVerifiedConcurrent = peakConcurrent(verifiedWindows);
  return { minutes, totals };
}

/**
 * The most windows open at one instant, by a sweep over start (+1) and end (-1) events. Windows are
 * half-open, so at equal times the end comes first: back-to-back sessions (a reconnect) never
 * overlap.
 */
export function peakConcurrent(windows: readonly { start: number; end: number }[]): number {
  const events: [at: number, delta: 1 | -1][] = [];
  for (const w of windows) {
    if (w.end <= w.start) continue;
    events.push([w.start, 1], [w.end, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let open = 0;
  let peak = 0;
  for (const [, delta] of events) {
    open += delta;
    if (open > peak) peak = open;
  }
  return peak;
}

/** Cost-model rates are kept to a millionth of a cent per GB. */
const RATE_SCALE = 1_000_000n;
const BYTES_PER_GB = 1_000_000_000n;

/**
 * Marginal egress cost in integer cents: Σ bytes(source) × centsPerGb(source) / 10^9, computed
 * exactly (bigint, rates to 10^-6 cent per GB) and rounded **once**, at the broadcast total,
 * half-up. A source the model leaves out (or bytes on a source with no rate, such as a CDN that is
 * off) costs 0.
 */
export function marginalCostCents(bytes: BySource, model: Pick<InfraCostModel, "centsPerGb">): number {
  let numerator = 0n;
  for (const source of DELIVERY_SOURCES) {
    const b = bytes[source] ?? 0;
    const rate = model.centsPerGb[source] ?? 0;
    if (b <= 0 || rate <= 0) continue;
    numerator += BigInt(Math.trunc(b)) * BigInt(Math.round(rate * Number(RATE_SCALE)));
  }
  const denominator = BYTES_PER_GB * RATE_SCALE;
  return Number((numerator + denominator / 2n) / denominator);
}

// ------------------------------------------------------------------------------- the job

/**
 * `INFRA_COST_MODEL` from an env source, read like startup reads it (`loadEnv`): a blank value, as
 * `.env.example` and compose `env_file` leave it, is unset and means the default model, not bad JSON.
 */
export const costModelFromEnv = (source: Record<string, string | undefined>): InfraCostModel =>
  loadEnv(costModelEnv, source).INFRA_COST_MODEL;

let envModel: InfraCostModel | null = null;
/** `INFRA_COST_MODEL` from the worker's env (validated at startup by `workerEnv`), read once. */
export function envCostModel(): InfraCostModel {
  envModel ??= costModelFromEnv(process.env);
  return envModel;
}

export interface RollupOptions {
  costModel: InfraCostModel;
}

const {
  broadcasts,
  playbackSessions,
  egressSamples,
  broadcastAudienceMinutes,
  broadcastAudienceTotals,
  broadcastCosts,
} = schema;

const verdictSchema = z.enum(["pending", "verified", "excluded"]);

/** The broadcast's owner has an active legal hold (ADR 0006): its analytics are kept as they are. */
const ownerHeld = (channelId: typeof broadcastAudienceTotals.channelId) =>
  sql`exists (select 1 from ${schema.legalHolds} h join ${schema.channels} c on c.owner_id = h.user_id
               where c.id = ${channelId} and h.released_at is null)`;

/** Roll one broadcast up (see the module comment). Exported for tests, which pass their own cost model. */
export async function rollupBroadcast(
  ctx: Pick<WorkerContext, "db" | "logger" | "now" | "enqueue">,
  data: RollupData,
  opts: RollupOptions,
): Promise<AnalyticsJobResult> {
  const now = ctx.now();
  const [b] = await ctx.db
    .select({
      id: broadcasts.id,
      channelId: broadcasts.channelId,
      kind: broadcasts.kind,
      startedAt: broadcasts.startedAt,
      endedAt: broadcasts.endedAt,
    })
    .from(broadcasts)
    .where(eq(broadcasts.id, data.broadcastId));
  if (!b) return { missing: 1 };
  if (b.kind === "rehearsal") return { rehearsal: 1 };
  if (!b.endedAt) return { live: 1 };
  const endedAt = b.endedAt;
  if (now.getTime() - endedAt.getTime() >= ANALYTICS_RULES.minuteRetentionDays * DAY_MS) return { final: 1 };
  if (data.reason !== "rescore") {
    // Verdicts move until the finalize window has passed (ADR 0014 decision 3). The outbox delays the
    // job until then; an early run (clock skew, a manual enqueue) waits for the rest.
    const settleMs = (data.settleSeconds ?? AUDIENCE_SETTLE_SECONDS) * 1000;
    const waitMs = endedAt.getTime() + settleMs - now.getTime();
    if (waitMs > 0) {
      await ctx.enqueue(QUEUES.analytics, ANALYTICS_JOBS.broadcastRollup, data, { delayMs: waitMs });
      return { deferred: 1 };
    }
  }

  const result = await ctx.db.transaction(async (tx): Promise<AnalyticsJobResult> => {
    // One rollup per broadcast at a time (an offline run racing a re-score).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`broadcast-rollup:${b.id}`}, 0))`);
    const [prior] = await tx
      .select({ purgedAt: broadcastAudienceTotals.minutesPurgedAt })
      .from(broadcastAudienceTotals)
      .where(eq(broadcastAudienceTotals.broadcastId, b.id));
    if (prior?.purgedAt) return { final: 1 };

    const rows = await tx
      .select({
        startedAt: playbackSessions.startedAt,
        endedAt: playbackSessions.endedAt,
        assignedSource: playbackSessions.assignedSource,
        verdict: playbackSessions.verdict,
        verdictReasons: playbackSessions.verdictReasons,
        scoredAt: playbackSessions.scoredAt,
      })
      .from(playbackSessions)
      .where(eq(playbackSessions.broadcastId, b.id));
    const sessions: RollupSession[] = rows.map((r) => ({
      ...r,
      verdict: verdictSchema.parse(r.verdict),
      verdictReasons: r.verdictReasons ?? [],
    }));
    const { minutes, totals } = rollUp({ startedAt: b.startedAt, endedAt }, sessions);

    const egress = await tx
      .select({ source: egressSamples.source, bytes: sql<string>`sum(${egressSamples.bytes})::text` })
      .from(egressSamples)
      .where(eq(egressSamples.broadcastId, b.id))
      .groupBy(egressSamples.source);
    const bytesBySource: BySource = {};
    for (const e of egress) {
      const n = Number(e.bytes);
      if (n > 0) bytesBySource[e.source] = n;
    }
    const costCents = marginalCostCents(bytesBySource, opts.costModel);

    await tx.delete(broadcastAudienceMinutes).where(eq(broadcastAudienceMinutes.broadcastId, b.id));
    await tx.delete(broadcastAudienceTotals).where(eq(broadcastAudienceTotals.broadcastId, b.id));
    await tx.delete(broadcastCosts).where(eq(broadcastCosts.broadcastId, b.id));
    for (let i = 0; i < minutes.length; i += INSERT_CHUNK) {
      await tx
        .insert(broadcastAudienceMinutes)
        .values(minutes.slice(i, i + INSERT_CHUNK).map((m) => ({ broadcastId: b.id, ...m })));
    }
    await tx.insert(broadcastAudienceTotals).values({
      broadcastId: b.id,
      channelId: b.channelId,
      ...totals,
      bytesBySource,
      rolledUpAt: now,
    });
    await tx.insert(broadcastCosts).values({
      broadcastId: b.id,
      currency: opts.costModel.currency,
      costCents,
      bytesBySource,
      model: { currency: opts.costModel.currency, centsPerGb: opts.costModel.centsPerGb },
      computedAt: now,
    });
    await emit(
      tx,
      "analytics.rollup.ready",
      b.channelId,
      { broadcast_id: b.id, channel_id: b.channelId, reason: data.reason },
      now,
    );
    return {
      rolledUp: 1,
      minutes: minutes.length,
      sessions: totals.sessions,
      verifiedViewerSeconds: totals.verifiedViewerSeconds,
      unverifiedViewerSeconds: totals.unverifiedViewerSeconds,
      excludedViewerSeconds: totals.excludedViewerSeconds,
      costCents,
    };
  });
  const purged = await purgeExpiredMinutes(ctx, now);
  return purged > 0 ? { ...result, purged } : result;
}

/**
 * Retention (`ANALYTICS_RULES.minuteRetentionDays`): delete the per-minute rows of broadcasts that
 * ended longer ago than that and mark their totals final (`minutes_purged_at`); the totals stay.
 * A channel whose owner is under a legal hold keeps its rows (the `ownerHeld` rule of
 * `housekeeping.ts`), re-checked under the hold lock right before the delete. Returns how many
 * broadcasts it purged.
 */
export async function purgeExpiredMinutes(
  ctx: Pick<WorkerContext, "db">,
  now: Date,
  batch = PURGE_BATCH,
): Promise<number> {
  const t = broadcastAudienceTotals;
  const cutoff = new Date(now.getTime() - ANALYTICS_RULES.minuteRetentionDays * DAY_MS);
  const due = await ctx.db
    .select({ broadcastId: t.broadcastId, channelId: t.channelId })
    .from(t)
    .innerJoin(broadcasts, eq(broadcasts.id, t.broadcastId))
    .where(and(isNull(t.minutesPurgedAt), lt(broadcasts.endedAt, cutoff), sql`not ${ownerHeld(t.channelId)}`))
    .orderBy(asc(broadcasts.endedAt))
    .limit(batch);
  let purged = 0;
  for (const d of due) {
    const done = await ctx.db.transaction(async (tx: Executor) => {
      const [owner] = await tx
        .select({ id: schema.channels.ownerId })
        .from(schema.channels)
        .where(eq(schema.channels.id, d.channelId));
      if (owner) {
        // Placing a hold takes the same lock, so a hold placed since the batch was chosen still wins.
        await lockLegalHold(tx, owner.id);
        const [held] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.legalHolds)
          .where(and(eq(schema.legalHolds.userId, owner.id), isNull(schema.legalHolds.releasedAt)));
        if ((held?.n ?? 0) > 0) return false;
      }
      await tx.delete(broadcastAudienceMinutes).where(eq(broadcastAudienceMinutes.broadcastId, d.broadcastId));
      await tx.update(t).set({ minutesPurgedAt: now }).where(eq(t.broadcastId, d.broadcastId));
      return true;
    });
    if (done) purged++;
  }
  return purged;
}

export const job = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.broadcastRollup,
  description: "Roll a settled broadcast's sessions up into per-minute audience, exclusion and cost rows",
  data: BroadcastRollupJob,
  attempts: 3,
  handler: async (data, ctx): Promise<AnalyticsJobResult> => {
    const out = await rollupBroadcast(ctx, data, { costModel: envCostModel() });
    ctx.logger.info("broadcast rollup", { broadcastId: data.broadcastId, reason: data.reason, ...out });
    return out;
  },
});

/** Daily retention pass for broadcasts no rollup run touches any more. */
export const retentionJob = defineJob({
  queue: QUEUES.analytics,
  name: ANALYTICS_JOBS.broadcastRollupRetention,
  description: "Delete per-minute audience rows past the retention window; per-broadcast totals stay",
  data: z.object({}),
  schedule: { pattern: "23 4 * * *" },
  handler: async (_data, ctx): Promise<AnalyticsJobResult> => {
    let purged = 0;
    for (;;) {
      const n = await purgeExpiredMinutes(ctx, ctx.now());
      purged += n;
      if (n < PURGE_BATCH) break;
    }
    return { purged };
  },
});
