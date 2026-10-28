// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The integrity pipeline as recurring jobs on the `integrity` queue (ADR 0003 §5). Each job
 * is its own BullMQ job scheduler (one enqueue per tick cluster-wide) and holds a run lock,
 * so at most one instance of each runs at a time across replicas, while different jobs run
 * side by side: a slow stream-hours pass never delays scoring. Failures retry with
 * exponential backoff; the next tick runs regardless.
 */
import { QUEUES } from "@commonair/contracts/internal";
import {
  excludeFollowBursts,
  markEligibleStreamHours,
  scoreActiveSessions,
  verifyReceipts,
} from "@commonair/integrity";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { refreshViewerCounts } from "../counters.ts";
import { metrics } from "../metrics.ts";
import { defineJob, type JobDefinition } from "../runtime/registry.ts";
import { withRunLock } from "./lock.ts";

export const INTEGRITY_JOBS = {
  scoreSessions: "score-sessions",
  verifyReceipts: "verify-receipts",
  followBursts: "follow-bursts",
  streamHours: "stream-hours",
} as const;
export type IntegrityJobName = (typeof INTEGRITY_JOBS)[keyof typeof INTEGRITY_JOBS];

export interface IntegrityJobSpec {
  everyMs: number;
  attempts: number;
  backoffMs: number;
  /** Past this a run stops renewing its lock, so a hung run cannot block the job forever. */
  maxRunMs: number;
}

export const INTEGRITY_SCHEDULES: Readonly<Record<IntegrityJobName, IntegrityJobSpec>> = {
  "score-sessions": { everyMs: 15_000, attempts: 3, backoffMs: 2_000, maxRunMs: 5 * 60_000 },
  "verify-receipts": { everyMs: 60_000, attempts: 3, backoffMs: 10_000, maxRunMs: 5 * 60_000 },
  "follow-bursts": { everyMs: 60_000, attempts: 3, backoffMs: 10_000, maxRunMs: 5 * 60_000 },
  "stream-hours": { everyMs: 5 * 60_000, attempts: 3, backoffMs: 30_000, maxRunMs: 20 * 60_000 },
};

/** Rows one run may touch; the rest wait for the next tick (least recently scored first). */
export const INTEGRITY_BATCH = { sessions: 2_000, receipts: 1_000 } as const;

export const RUN_LOCK_TTL_MS = 30_000;
export const runLockKey = (name: IntegrityJobName) => `worker:lock:integrity:${name}`;

export interface IntegrityJobOptions {
  /** Per-job interval overrides (tests). */
  everyMs?: Partial<Record<IntegrityJobName, number>>;
  batch?: Partial<typeof INTEGRITY_BATCH>;
}

type Counts = Record<string, number>;

function integrityJob(
  name: IntegrityJobName,
  description: string,
  opts: IntegrityJobOptions,
  run: (ctx: WorkerContext) => Promise<Counts>,
): JobDefinition {
  const spec = INTEGRITY_SCHEDULES[name];
  return defineJob({
    queue: QUEUES.integrity,
    name,
    description,
    data: z.object({}),
    schedule: { every: opts.everyMs?.[name] ?? spec.everyMs },
    attempts: spec.attempts,
    backoffMs: spec.backoffMs,
    handler: async (_data, ctx) => {
      const r = await withRunLock(
        ctx.valkey,
        runLockKey(name),
        { ttlMs: RUN_LOCK_TTL_MS, maxHoldMs: spec.maxRunMs, job: name, logger: ctx.logger },
        () => run(ctx),
      );
      metrics.integrityRuns.add(1, { job: name, outcome: r.acquired ? "ran" : "skipped" });
      if (!r.acquired) {
        ctx.logger.debug("integrity job skipped: previous run still in progress", { job: name });
        return { skipped: true };
      }
      return r.value;
    },
  });
}

async function channelsOf(ctx: WorkerContext, sessionIds: readonly string[]): Promise<string[]> {
  if (sessionIds.length === 0) return [];
  const rows = await ctx.sql<{ channel_id: string }[]>`
    select distinct channel_id from playback_sessions where id = any(${[...sessionIds]}::uuid[])`;
  return rows.map((r) => r.channel_id);
}

export async function runScoring(ctx: WorkerContext, limit: number = INTEGRITY_BATCH.sessions): Promise<Counts> {
  const r = await scoreActiveSessions(ctx.db, ctx.valkey, ctx.now(), { classifier: ctx.classifier(), limit });
  for (const [verdict, n] of Object.entries(r.counts)) if (n > 0) metrics.integritySessions.add(n, { verdict });
  if (r.newlyExcluded.length) metrics.integrityActions.add(r.newlyExcluded.length, { kind: "session_excluded" });
  // Which rule excluded whom: session id, codes, sub-checks and measured numbers only (no PII).
  for (const e of r.exclusions) ctx.logger.info("integrity session excluded", { ...e });
  if (r.restored.length) metrics.integrityActions.add(r.restored.length, { kind: "session_restored" });
  if (r.superseded.length) metrics.integrityActions.add(r.superseded.length, { kind: "session_superseded" });
  if (r.p2p.evidenced) metrics.integrityEvidence.add(r.p2p.evidenced, { source: "p2p", outcome: "evidenced" });
  if (r.p2p.errors) {
    metrics.integrityEvidence.add(r.p2p.errors, { source: "p2p", outcome: "error" });
    ctx.logger.warn("p2p evidence reads failed; affected sessions judged without it", { errors: r.p2p.errors });
  }
  // An exclusion, restore or supersede changes who counts: republish those channels' counts now.
  const changed = [...r.newlyExcluded, ...r.restored, ...r.superseded];
  const channels = await refreshViewerCounts(ctx, await channelsOf(ctx, changed));
  const counts = {
    scored: r.scored,
    verified: r.counts.verified,
    pending: r.counts.pending,
    excluded: r.counts.excluded,
    newlyExcluded: r.newlyExcluded.length,
    restored: r.restored.length,
    superseded: r.superseded.length,
    p2pEvidenced: r.p2p.evidenced,
    p2pErrors: r.p2p.errors,
    channelsRecounted: channels,
  };
  if (changed.length > 0) ctx.logger.info("integrity scoring", counts);
  else ctx.logger.debug("integrity scoring", counts);
  return counts;
}

export async function runReceipts(ctx: WorkerContext, limit: number = INTEGRITY_BATCH.receipts): Promise<Counts> {
  // With Valkey, suspended relays leave `KEYS.relays` at once (assignment stops immediately).
  const r = await verifyReceipts(ctx.db, ctx.now(), { limit, valkey: ctx.valkey });
  if (r.verified) metrics.integrityActions.add(r.verified, { kind: "receipt_verified" });
  if (r.rejected) metrics.integrityActions.add(r.rejected, { kind: "receipt_rejected" });
  if (r.unknown) metrics.integrityActions.add(r.unknown, { kind: "receipt_issuance_unknown" });
  if (r.suspendedRelays.length) metrics.integrityActions.add(r.suspendedRelays.length, { kind: "relay_suspended" });
  if (r.deassignFailed) {
    metrics.integrityActions.add(r.deassignFailed, { kind: "relay_deassign_failed" });
    ctx.logger.warn("suspended relays not removed from assignment; they leave on their next heartbeat", {
      relays: r.deassignFailed,
    });
  }
  const counts = {
    verified: r.verified,
    rejected: r.rejected,
    unknown: r.unknown,
    suspendedRelays: r.suspendedRelays.length,
    deassignFailed: r.deassignFailed,
  };
  if (r.verified + r.rejected + r.unknown > 0) ctx.logger.info("relay receipts checked", counts);
  return counts;
}

export async function runFollowBursts(ctx: WorkerContext): Promise<Counts> {
  const r = await excludeFollowBursts(ctx.db, ctx.now());
  if (r.excluded.length) metrics.integrityActions.add(r.excluded.length, { kind: "follow_excluded" });
  const counts = { channels: r.channels.length, excluded: r.excluded.length };
  if (r.excluded.length > 0) ctx.logger.info("follow bursts excluded", counts);
  return counts;
}

export async function runStreamHours(ctx: WorkerContext): Promise<Counts> {
  const r = await markEligibleStreamHours(ctx.db, ctx.now());
  if (r.updated) {
    metrics.streamHoursEligible.add(r.eligible, { eligible: "true" });
    metrics.streamHoursEligible.add(r.updated - r.eligible, { eligible: "false" });
  }
  const counts = { updated: r.updated, eligible: r.eligible };
  if (r.updated > 0) ctx.logger.info("stream hours recomputed", counts);
  return counts;
}

/** The four integrity jobs (the shipped registry uses the defaults). */
export function integrityJobs(opts: IntegrityJobOptions = {}): JobDefinition[] {
  const batch = { ...INTEGRITY_BATCH, ...opts.batch };
  return [
    integrityJob("score-sessions", "Score active playback sessions (verified / pending / excluded)", opts, (ctx) =>
      runScoring(ctx, batch.sessions),
    ),
    integrityJob(
      "verify-receipts",
      "Check relay receipts against issuance; suspend over-reporting relays",
      opts,
      (ctx) => runReceipts(ctx, batch.receipts),
    ),
    integrityJob("follow-bursts", "Exclude low-quality follows that arrived in bursts", opts, runFollowBursts),
    integrityJob("stream-hours", "Recompute streaming-hour eligibility from verified viewers", opts, runStreamHours),
  ];
}
