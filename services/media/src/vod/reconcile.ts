// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * VODs nobody is finishing: `recording` VODs whose broadcast ended while no session ran, and
 * `processing` VODs whose finalize job is gone (removed, exhausted its retries, or lost with a
 * crashed process). A BullMQ job id equals the VOD id, so the job's state tells whether a worker
 * owns the VOD. Unowned VODs are re-queued (finalize is idempotent and resumes), but a VOD that
 * still is not finished `failAfterMs` after its broadcast ended is marked `failed` with a
 * `failedReason`.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";

/** `failedReason` of a VOD that never finished processing (stable code, see README). */
export const VOD_STALLED_REASON = "finalize_stalled";

export type FinalizeJobState =
  | "active"
  | "waiting"
  | "waiting-children"
  | "delayed"
  | "prioritized"
  | "completed"
  | "failed"
  | "unknown";

export interface FinalizeJobInfo {
  state: FinalizeJobState;
  /** Epoch ms the job last finished (completed or failed), if it did. */
  finishedOn: number | null;
}

export interface FinalizeJobControl {
  info(vodId: string): Promise<FinalizeJobInfo>;
  /** Replace any finished job for the VOD with a fresh one. */
  requeue(vodId: string): Promise<void>;
}

export type VodDecision = "owned" | "requeue" | "wait" | "fail";

const OWNED: ReadonlySet<FinalizeJobState> = new Set([
  "active",
  "waiting",
  "waiting-children",
  "delayed",
  "prioritized",
]);

/** Pure decision for one unfinished VOD. */
export function decideVod(opts: {
  job: FinalizeJobInfo;
  /** When the broadcast ended (or the VOD last changed, if the broadcast has not ended). */
  since: Date;
  now: Date;
  failAfterMs: number;
  retryAfterMs: number;
}): VodDecision {
  if (OWNED.has(opts.job.state)) return "owned";
  if (opts.now.getTime() - opts.since.getTime() >= opts.failAfterMs) return "fail";
  if (opts.job.state === "unknown" || opts.job.finishedOn === null) return "requeue";
  // A job that just failed (all retries used): give the cause (storage outage, disk budget) time.
  return opts.now.getTime() - opts.job.finishedOn >= opts.retryAfterMs ? "requeue" : "wait";
}

export interface VodReconcileDeps {
  db: Database;
  jobs: FinalizeJobControl;
  logger: Logger;
  failAfterMs: number;
  retryAfterMs: number;
  now?: () => Date;
}

export interface VodReconcileResult {
  requeued: string[];
  failed: string[];
}

/** `live`: broadcasts with a running session here (their VOD is still being written). */
export async function reconcileVods(deps: VodReconcileDeps, live: ReadonlySet<string>): Promise<VodReconcileResult> {
  const v = schema.vods;
  const b = schema.broadcasts;
  const rows = await deps.db
    .select({ id: v.id, status: v.status, broadcastId: v.broadcastId, updatedAt: v.updatedAt, endedAt: b.endedAt })
    .from(v)
    .innerJoin(b, eq(b.id, v.broadcastId))
    .where(or(eq(v.status, "processing"), and(eq(v.status, "recording"), isNotNull(b.endedAt))));
  const now = deps.now?.() ?? new Date();
  const result: VodReconcileResult = { requeued: [], failed: [] };
  for (const row of rows) {
    if (live.has(row.broadcastId)) continue;
    const job = await deps.jobs.info(row.id);
    const decision = decideVod({
      job,
      since: row.endedAt ?? row.updatedAt,
      now,
      failAfterMs: deps.failAfterMs,
      retryAfterMs: deps.retryAfterMs,
    });
    if (decision === "requeue") {
      await deps.jobs.requeue(row.id);
      result.requeued.push(row.id);
    } else if (decision === "fail") {
      // Conditional on the status so a finalize finishing right now is not overwritten.
      const done = await deps.db
        .update(v)
        .set({ status: "failed", failedReason: VOD_STALLED_REASON })
        .where(and(eq(v.id, row.id), inArray(v.status, ["recording", "processing"])))
        .returning({ id: v.id });
      if (done.length > 0) result.failed.push(row.id);
    }
  }
  if (result.requeued.length > 0 || result.failed.length > 0)
    deps.logger.info("reconcile: unfinished VODs", { requeued: result.requeued.length, failed: result.failed.length });
  return result;
}
