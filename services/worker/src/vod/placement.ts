// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `vod-placement` (ADR 0009 amendment 1, decision 3): a reconciler that moves a VOD's objects to
 * where `vodPlacement` of its database state says they belong, the public `vods/<id>/` or the
 * private `recordings/<id>/`. It decides nothing, so it writes no audit row; it logs ids and
 * counts only, never keys.
 *
 * A move: server-side copy and verify every object (`moveVodObjects`), then switch
 * `storage_prefix` and `thumbnail_key` in one transaction that re-checks the state, then delete the
 * source. A crash anywhere leaves at least one complete copy and the next run finishes. A legal
 * hold never blocks a move (it only blocks deletion); `leave` (NCII or DMCA flows own the keys, or
 * the VOD is deleted) moves nothing. `recording` and `processing` VODs belong to media's finalize,
 * which moves them itself before they become `ready`.
 *
 * The sweep (no `vodId`, every minute and on the ops hook) selects VODs whose `storage_prefix`
 * disagrees with their state in SQL, in batches, and enqueues one job each. Its first runs also
 * move every VOD recorded before the private prefix existed (decision 5).
 */
import { QUEUES } from "@commonair/contracts/internal";
import {
  isVodOwnPrefix,
  VOD_PRIVATE_PREFIX,
  VOD_PUBLIC_PREFIX,
  vodPlacement,
  vodPrefix,
  type VodPlacement,
  type VodPlacementState,
} from "@commonair/contracts/storage";
import { schema, type Executor } from "@commonair/db";
import { moveVodObjects } from "@commonair/storage";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { withRunLock } from "../integrity/lock.ts";
import { otherVodPrefix, rebaseKey } from "./prefixes.ts";

const { vods, broadcasts, channels } = schema;

export const VOD_PLACEMENT_JOB = "vod-placement";
/** VODs enqueued per sweep; the rest wait for the next minute. */
export const VOD_PLACEMENT_SWEEP_BATCH = 200;
/** Per-VOD run lock: one move at a time per VOD, across replicas and against retention. */
export const vodPlacementLockKey = (vodId: string) => `worker:lock:vod-placement:${vodId}`;
const LOCK = { ttlMs: 30_000, maxHoldMs: 60 * 60_000 };

/**
 * BullMQ refuses custom ids with one `:`; and a completed job's id is kept for an hour, so a fixed
 * per-VOD id would swallow the next state change. The minute bucket dedupes within one sweep.
 */
export const vodPlacementJobId = (vodId: string, at: Date) =>
  `vod-placement-${vodId}-${Math.floor(at.getTime() / 60_000)}`;

/** A hidden NCII item covers the VOD (auto-hidden or removed: the NCII flow owns its objects). */
const nciiHidden = sql<boolean>`exists (select 1 from ${schema.nciiRequestItems} i where i.subject_type = 'vod' and i.subject_id = ${vods.id} and (i.hidden_at is not null or i.removed_at is not null))`;
/**
 * A DMCA item covering the VOD (or its broadcast) is removed and not restored. From the takedown
 * on, not only once `objects_hidden_at` is set: `dmca-disable` moves the objects first and marks
 * the item after, and a move in between would leave the restore putting them back elsewhere.
 */
const dmcaHidden = sql<boolean>`exists (select 1 from ${schema.dmcaNoticeItems} d where ((d.subject_type = 'vod' and d.subject_id = ${vods.id}) or (d.subject_type = 'broadcast' and d.subject_id = ${vods.broadcastId})) and d.removed_at is not null and d.restored_at is null)`;

/** `vodPlacement` in SQL, for the sweep: `vods/<id>/` when public, else `recordings/<id>/`. */
const publicPrefix = sql`${VOD_PUBLIC_PREFIX}::text || ${vods.id}::text || '/'`;
const privatePrefix = sql`${VOD_PRIVATE_PREFIX}::text || ${vods.id}::text || '/'`;
const targetPrefix = sql<string>`case when ${vods.status} = 'ready' and ${vods.visibility} = 'public' and ${vods.removedReason} is null and ${broadcasts.restrictedAt} is null and ${channels.suspendedAt} is null then ${publicPrefix} else ${privatePrefix} end`;
/** `isVodOwnPrefix` in SQL. */
export const ownVodPrefix = sql`${vods.storagePrefix} in (${publicPrefix}, ${privatePrefix})`;

export interface PlacementRow {
  storagePrefix: string;
  thumbnailKey: string | null;
  state: VodPlacementState;
}

/** The VOD's placement inputs and where its objects are now, or null when there is no such VOD. */
export async function loadPlacement(db: Executor, vodId: string): Promise<PlacementRow | null> {
  const [row] = await db
    .select({
      storagePrefix: vods.storagePrefix,
      thumbnailKey: vods.thumbnailKey,
      status: vods.status,
      visibility: vods.visibility,
      removedReason: vods.removedReason,
      broadcastRestricted: sql<boolean>`${broadcasts.restrictedAt} is not null`,
      channelSuspended: sql<boolean>`${channels.suspendedAt} is not null`,
      nciiHidden,
      dmcaHidden,
    })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .where(eq(vods.id, vodId));
  if (!row) return null;
  const { storagePrefix, thumbnailKey, ...state } = row;
  return { storagePrefix, thumbnailKey, state };
}

export type PlacementOutcome =
  | "moved"
  | "in_place"
  | "left"
  | "finalizing"
  | "missing"
  | "refused"
  | "busy"
  | "raced"
  | "no_storage";

export interface PlacementResult {
  outcome: PlacementOutcome;
  /** Objects copied (moved) or stray copies deleted (in place). */
  objects: number;
}

/** Bring one VOD's objects in line with its state. Idempotent; safe to run concurrently (per-VOD lock). */
export async function placeVod(ctx: WorkerContext, vodId: string): Promise<PlacementResult> {
  const storage = ctx.storage;
  if (!storage) return { outcome: "no_storage", objects: 0 };
  const log = ctx.logger.child({ job: VOD_PLACEMENT_JOB, vodId });
  const r = await withRunLock(
    ctx.valkey,
    vodPlacementLockKey(vodId),
    { ...LOCK, job: VOD_PLACEMENT_JOB, logger: ctx.logger },
    async (): Promise<PlacementResult> => {
      const row = await loadPlacement(ctx.db, vodId);
      if (!row) return { outcome: "missing", objects: 0 };
      if (row.state.status === "recording" || row.state.status === "processing")
        return { outcome: "finalizing", objects: 0 };
      // A prefix the VOD does not own is never read, copied or deleted (retention refuses it too).
      if (!isVodOwnPrefix(vodId, row.storagePrefix)) {
        log.error("vod-placement: refusing unexpected storage prefix");
        return { outcome: "refused", objects: 0 };
      }
      const placement = vodPlacement(row.state);
      if (placement === "leave") return { outcome: "left", objects: 0 };
      const to = vodPrefix(vodId, placement);
      if (row.storagePrefix === to) {
        // Already in place: copies an interrupted move left at the other prefix go.
        const strays = await storage.deletePrefix(ctx.mediaBucket, otherVodPrefix(vodId, to));
        if (strays > 0) log.info("vod-placement: deleted stray copies", { objects: strays });
        return { outcome: "in_place", objects: strays };
      }
      return move(ctx, vodId, row, placement, to, log);
    },
  );
  return r.acquired ? r.value : { outcome: "busy", objects: 0 };
}

async function move(
  ctx: WorkerContext,
  vodId: string,
  row: PlacementRow,
  placement: VodPlacement,
  to: string,
  log: WorkerContext["logger"],
): Promise<PlacementResult> {
  const storage = ctx.storage;
  if (!storage) return { outcome: "no_storage", objects: 0 };
  const from = row.storagePrefix;
  const { copied, bytes } = await moveVodObjects(storage, ctx.mediaBucket, from, to);
  const committed = await ctx.db.transaction(async (tx) => {
    await tx.select({ id: vods.id }).from(vods).where(eq(vods.id, vodId)).for("update");
    const now = await loadPlacement(tx, vodId);
    // The state changed while copying (or another writer moved it): the next run decides again.
    if (!now || now.storagePrefix !== from || vodPlacement(now.state) !== placement) return false;
    await tx
      .update(vods)
      .set({
        storagePrefix: to,
        thumbnailKey: now.thumbnailKey === null ? null : rebaseKey(now.thumbnailKey, from, to),
      })
      .where(eq(vods.id, vodId));
    return true;
  });
  if (!committed) {
    // The source is intact; the copies go unless the row points at them now.
    const now = await loadPlacement(ctx.db, vodId);
    if (now && now.storagePrefix !== to) await storage.deletePrefix(ctx.mediaBucket, to);
    log.info("vod-placement: state changed during the copy; not moved");
    return { outcome: "raced", objects: 0 };
  }
  await storage.deletePrefix(ctx.mediaBucket, from);
  log.info("vod-placement: moved", { placement, objects: copied, bytes });
  return { outcome: "moved", objects: copied };
}

/**
 * VODs whose `storage_prefix` disagrees with their state, oldest id first. Excludes what placement
 * leaves alone (deleted, NCII, DMCA), what finalize still owns, and prefixes the VOD does not own.
 */
export async function misplacedVods(db: Executor, limit = VOD_PLACEMENT_SWEEP_BATCH): Promise<string[]> {
  const rows = await db
    .select({ id: vods.id })
    .from(vods)
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .where(
      and(
        notInArray(vods.status, ["deleted", "recording", "processing"]),
        ownVodPrefix,
        sql`not ${nciiHidden}`,
        sql`not ${dmcaHidden}`,
        sql`${vods.storagePrefix} <> ${targetPrefix}`,
      ),
    )
    .orderBy(asc(vods.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** The one-minute sweep: enqueue a placement job for each misplaced VOD (counts only in the log). */
export async function sweepVodPlacement(ctx: WorkerContext, batch = VOD_PLACEMENT_SWEEP_BATCH) {
  if (!ctx.storage) {
    ctx.logger.warn("vod-placement skipped: object storage is not configured");
    return { enqueued: 0 };
  }
  const ids = await misplacedVods(ctx.db, batch);
  const at = ctx.now();
  await ctx.enqueueBulk(
    QUEUES.retention,
    ids.map((vodId) => ({
      name: VOD_PLACEMENT_JOB,
      data: { vodId },
      opts: { jobId: vodPlacementJobId(vodId, at) },
    })),
  );
  if (ids.length > 0) ctx.logger.info("vod-placement sweep", { enqueued: ids.length, full: ids.length >= batch });
  return { enqueued: ids.length };
}
