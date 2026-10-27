// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The NCII 48-hour clock (TAKE IT DOWN Act; e4c spec "NCII clock"), every minute and on demand
 * (`asOf`, test hooks only). At 24 h undecided: `escalated24_at`, moderators and `legal` notified
 * again. At 36 h: `escalated36_at`, `legal` and admins notified. At the deadline (48 h, a database
 * constant) undecided: `auto_hidden`, every resolved subject hidden (VOD/clip `deleted` with
 * `ncii_deadline`, uploads' references cleared, live ended), audit `ncii.auto_hide`, event
 * `ncii.request.decided`; then the public objects move to a private prefix. A run more than
 * NCII_CLOCK_LAPSE_ALERT_MINUTES after the previous one raises an alert. Under a run lock.
 */
import { NciiClockResult, type NciiClockJob } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { MODERATION_CONSTANTS } from "@commonair/moderation";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { withRunLock } from "../integrity/lock.ts";
import { moderationMetrics } from "./metrics.ts";
import { moveObject, nciiHiddenKey } from "./objects.ts";
import { vodObjectPrefixes } from "../vod/prefixes.ts";
import {
  alert,
  audit,
  clearUploadReferences,
  emit,
  endBroadcast,
  hideContent,
  notifyRoles,
  safeErrorCode,
  type EndedBroadcast,
} from "./records.ts";
import { publishLiveEnded } from "./t0.ts";

const { nciiRequests: requests, nciiRequestItems: items, clips, vods } = schema;
const HOUR = 3_600_000;

export const NCII_CLOCK_LOCK = "worker:lock:moderation:ncii-clock";
export const NCII_CLOCK_LAST_RUN = "worker:moderation:ncii-clock:last-run";
/** Request ids whose hidden objects still need moving to the private prefix. */
export const NCII_PENDING_MOVES = "worker:moderation:ncii-clock:pending-moves";
export const NCII_REASON = "ncii_deadline";

export interface ClockState {
  receivedAt: Date;
  deadlineAt: Date;
  status: string;
  decidedAt: Date | null;
  escalated24At: Date | null;
  escalated36At: Date | null;
  autoHiddenAt: Date | null;
}

export interface ClockStep {
  escalate24: boolean;
  escalate36: boolean;
  autoHide: boolean;
}

/** What is due for one request at `asOf`. Pure: boundaries are inclusive (exactly 24 h fires). */
export function clockStep(r: ClockState, asOf: Date): ClockStep {
  const open = r.decidedAt === null && r.status === "received";
  const age = asOf.getTime() - r.receivedAt.getTime();
  return {
    escalate24: open && r.escalated24At === null && age >= MODERATION_CONSTANTS.NCII_ESCALATE_FIRST_HOURS * HOUR,
    escalate36: open && r.escalated36At === null && age >= MODERATION_CONSTANTS.NCII_ESCALATE_SECOND_HOURS * HOUR,
    autoHide: open && r.autoHiddenAt === null && asOf.getTime() >= r.deadlineAt.getTime(),
  };
}

/** True when the gap since the previous run exceeds the lapse threshold. */
export function lapsed(previousMs: number | null, nowMs: number): boolean {
  return previousMs !== null && nowMs - previousMs > MODERATION_CONSTANTS.NCII_CLOCK_LAPSE_ALERT_MINUTES * 60_000;
}

/** `asOf` is honoured only with test hooks on; otherwise it is the worker's clock. */
export function effectiveAsOf(ctx: WorkerContext, job: NciiClockJob): Date {
  if (!job.asOf) return ctx.now();
  if (ctx.moderation?.testHooks) return new Date(job.asOf);
  ctx.logger.warn("ncii-clock asOf ignored: test hooks are off");
  return ctx.now();
}

async function checkLapse(ctx: WorkerContext) {
  const now = ctx.now().getTime();
  const prev = await ctx.valkey.get(NCII_CLOCK_LAST_RUN);
  const prevMs = prev === null ? null : Number(prev);
  if (lapsed(prevMs !== null && Number.isFinite(prevMs) ? prevMs : null, now))
    alert(ctx, "ncii_clock_lapsed", "the NCII clock did not run on time", {
      gapMinutes: Math.round((now - (prevMs ?? now)) / 60_000),
    });
  await ctx.valkey.set(NCII_CLOCK_LAST_RUN, String(now), "EX", 7 * 24 * 3600);
}

type RequestRow = typeof requests.$inferSelect;

async function escalate(ctx: WorkerContext, r: RequestRow, stage: 24 | 36, asOf: Date): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const col = stage === 24 ? requests.escalated24At : requests.escalated36At;
    const [row] = await tx
      .update(requests)
      .set(stage === 24 ? { escalated24At: asOf } : { escalated36At: asOf })
      .where(and(eq(requests.id, r.id), isNull(col), isNull(requests.decidedAt), eq(requests.status, "received")))
      .returning({ id: requests.id });
    if (!row) return false;
    const payload = { kind: "ncii_escalated", requestId: r.id, stage, deadlineAt: r.deadlineAt.toISOString() };
    const notified = await notifyRoles(tx, stage === 24 ? ["moderator", "legal"] : ["legal", "admin"], payload, asOf);
    await audit(
      tx,
      {
        action: `ncii.escalate_${stage}`,
        subjectType: "ncii_request",
        subjectId: r.id,
        reason: "ncii_clock",
        details: { requestId: r.id, stage, notified, deadlineAt: r.deadlineAt.toISOString() },
      },
      asOf,
    );
    return true;
  });
}

/** The auto-hide transaction. Returns the ended broadcasts (for the after-commit messages). */
async function autoHide(ctx: WorkerContext, r: RequestRow, asOf: Date) {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(requests)
      .set({ status: "auto_hidden", autoHiddenAt: asOf })
      .where(
        and(
          eq(requests.id, r.id),
          isNull(requests.decidedAt),
          isNull(requests.autoHiddenAt),
          eq(requests.status, "received"),
        ),
      )
      .returning({ id: requests.id });
    if (!row) return null;
    const rows = await tx.select().from(items).where(eq(items.requestId, r.id)).for("update");
    const vodIds = rows.filter((i) => i.subjectType === "vod" && i.subjectId).map((i) => i.subjectId as string);
    const clipIds = rows.filter((i) => i.subjectType === "clip" && i.subjectId).map((i) => i.subjectId as string);
    const hidden = await hideContent(tx, { vodIds, clipIds }, NCII_REASON);
    const ended: EndedBroadcast[] = [];
    for (const i of rows.filter((x) => x.subjectType === "broadcast" && x.subjectId)) {
      const e = await endBroadcast(tx, i.subjectId as string, asOf);
      if (e) ended.push(e);
    }
    let uploads = 0;
    for (const i of rows.filter((x) => x.subjectType === "upload" && x.uploadKey))
      uploads += await clearUploadReferences(tx, i.uploadKey as string);
    const resolved = rows.filter((i) => i.subjectType !== null);
    if (resolved.length > 0)
      await tx
        .update(items)
        .set({ hiddenAt: asOf })
        .where(
          and(
            inArray(
              items.id,
              resolved.map((i) => i.id),
            ),
            isNull(items.hiddenAt),
          ),
        );
    await audit(
      tx,
      {
        action: "ncii.auto_hide",
        subjectType: "ncii_request",
        subjectId: r.id,
        reason: NCII_REASON,
        details: {
          requestId: r.id,
          items: rows.length,
          resolvedItems: resolved.length,
          vodIds: hidden.vodIds,
          clipIds: hidden.clipIds,
          endedBroadcastIds: ended.map((e) => e.broadcastId),
          uploadReferencesCleared: uploads,
          deadlineAt: r.deadlineAt.toISOString(),
        },
      },
      asOf,
    );
    await emit(tx, "ncii.request.decided", null, { request_id: r.id, decision: "auto_hidden" }, asOf);
    return { ended };
  });
}

/**
 * Move the public objects of an auto-hidden request's items to the private prefix. Safe to repeat:
 * a missing source means it already moved. Only items marked hidden are touched.
 */
export async function moveHiddenObjects(ctx: WorkerContext, requestId: string): Promise<number> {
  const storage = ctx.storage;
  if (!storage) return 0;
  const rows = await ctx.db
    .select()
    .from(items)
    .where(and(eq(items.requestId, requestId), isNotNull(items.hiddenAt), isNull(items.removedAt)));
  const keys: string[] = [];
  for (const i of rows) {
    if (i.subjectType === "vod" && i.subjectId) {
      const [v] = await ctx.db.select({ prefix: vods.storagePrefix }).from(vods).where(eq(vods.id, i.subjectId));
      // The row's prefix first, then the other own one (a placement move may have been in flight).
      for (const prefix of vodObjectPrefixes(i.subjectId, v?.prefix))
        for await (const o of storage.list(ctx.mediaBucket, prefix)) keys.push(o.key);
    }
    if (i.subjectType === "clip" && i.subjectId) {
      const [c] = await ctx.db
        .select({ s: clips.storageKey, t: clips.thumbnailKey })
        .from(clips)
        .where(eq(clips.id, i.subjectId));
      for (const k of [c?.s, c?.t]) if (k) keys.push(k);
    }
    if (i.subjectType === "upload" && i.uploadKey) keys.push(i.uploadKey);
  }
  let moved = 0;
  for (const k of keys) if (await moveObject(storage, ctx.mediaBucket, k, nciiHiddenKey(k))) moved++;
  return moved;
}

async function drainPendingMoves(ctx: WorkerContext) {
  const pending = await ctx.valkey.smembers(NCII_PENDING_MOVES);
  for (const id of pending) {
    try {
      const [r] = await ctx.db.select({ status: requests.status }).from(requests).where(eq(requests.id, id));
      if (r?.status === "auto_hidden") await moveHiddenObjects(ctx, id);
      await ctx.valkey.srem(NCII_PENDING_MOVES, id);
    } catch (err) {
      alert(ctx, "ncii_hide_move_failed", "hidden NCII objects could not be moved to the private prefix", {
        requestId: id,
        errorCode: safeErrorCode(err),
      });
    }
  }
}

export async function runNciiClockOnce(ctx: WorkerContext, asOf: Date): Promise<NciiClockResult> {
  await checkLapse(ctx);
  const result: NciiClockResult = { escalated24: 0, escalated36: 0, autoHidden: 0 };
  const due = await ctx.db
    .select()
    .from(requests)
    .where(
      and(
        isNull(requests.decidedAt),
        eq(requests.status, "received"),
        sql`${requests.receivedAt} <= ${new Date(asOf.getTime() - MODERATION_CONSTANTS.NCII_ESCALATE_FIRST_HOURS * HOUR).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(requests.deadlineAt))
    .limit(500);
  for (const r of due) {
    const step = clockStep(r, asOf);
    try {
      if (step.escalate24 && (await escalate(ctx, r, 24, asOf))) result.escalated24++;
      if (step.escalate36 && (await escalate(ctx, r, 36, asOf))) result.escalated36++;
      if (step.autoHide) {
        // Recorded before the transaction so a crash after commit still gets its objects moved.
        await ctx.valkey.sadd(NCII_PENDING_MOVES, r.id);
        const hid = await autoHide(ctx, r, asOf);
        if (hid) {
          result.autoHidden++;
          moderationMetrics.actions.add(1, { kind: "ncii_auto_hide" });
          for (const e of hid.ended) await publishLiveEnded(ctx, e, ctx.now());
        }
      }
    } catch (err) {
      // One request failing must not stop the others; it is retried next minute.
      alert(ctx, "ncii_clock_request_failed", "the NCII clock could not process a request", {
        requestId: r.id,
        errorCode: safeErrorCode(err),
      });
    }
  }
  await drainPendingMoves(ctx);
  if (result.escalated24 + result.escalated36 + result.autoHidden > 0)
    ctx.logger.info("NCII clock run", { ...result, asOf: asOf.toISOString() });
  return NciiClockResult.parse(result);
}

/** The job: under the run lock. An on-demand (`asOf`) run waits for a scheduled run to finish. */
export async function nciiClock(ctx: WorkerContext, job: NciiClockJob): Promise<NciiClockResult> {
  const asOf = effectiveAsOf(ctx, job);
  const deadline = Date.now() + (job.asOf ? 25_000 : 0);
  for (;;) {
    const r = await withRunLock(
      ctx.valkey,
      NCII_CLOCK_LOCK,
      { ttlMs: 30_000, maxHoldMs: 10 * 60_000, job: "ncii-clock", logger: ctx.logger },
      () => runNciiClockOnce(ctx, asOf),
    );
    if (r.acquired) {
      moderationMetrics.runs.add(1, { job: "ncii-clock", outcome: "ran" });
      return r.value;
    }
    if (Date.now() >= deadline) {
      moderationMetrics.runs.add(1, { job: "ncii-clock", outcome: "skipped" });
      return { escalated24: 0, escalated36: 0, autoHidden: 0 };
    }
    await Bun.sleep(200);
  }
}
