// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notifications` retention (decided 2026-10-30): every row older than `retentionDays`, and read
 * `go_live` rows older than `readGoLiveRetentionDays`, whatever the user. Each batch is its own
 * short DELETE on `notifications_created_idx` (oldest first), so no long transaction and no table
 * lock; the loop ends on a short batch. Notifications are not append-only and carry no audit duty:
 * no audit or outbox row.
 */
import { NOTIFY_RULES } from "@commonair/contracts/notify";
import { sql, type SQL } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";

const DAY_MS = 86_400_000;

export interface PruneOptions {
  /** Rows per DELETE (default `NOTIFY_RULES.pruneBatchSize`). */
  batchSize?: number;
  retentionDays?: number;
  readGoLiveRetentionDays?: number;
}

export interface PruneResult {
  /** Every row removed, by either rule. */
  deleted: number;
  /** Of those, read `go_live` rows removed by the shorter rule. */
  readGoLive: number;
}

export interface PruneCutoffs {
  /** Rows created strictly before this go. */
  all: Date;
  /** Read `go_live` rows created strictly before this go. */
  readGoLive: Date;
}

/** "Older than N days" is strict: a row exactly N days old is kept. */
export function pruneCutoffs(
  now: Date,
  retentionDays: number = NOTIFY_RULES.retentionDays,
  readGoLiveRetentionDays: number = NOTIFY_RULES.readGoLiveRetentionDays,
): PruneCutoffs {
  return {
    all: new Date(now.getTime() - retentionDays * DAY_MS),
    readGoLive: new Date(now.getTime() - readGoLiveRetentionDays * DAY_MS),
  };
}

const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** The rows each rule deletes. */
export const pruneRules = (c: PruneCutoffs): { all: SQL; readGoLive: SQL } => ({
  all: sql`created_at < ${tsz(c.all)}`,
  readGoLive: sql`created_at < ${tsz(c.readGoLive)} and type = 'go_live' and read_at is not null`,
});

/**
 * One batch: the oldest `batchSize` matching rows, at or after `from` (the newest `created_at` the
 * previous batch deleted). The lower bound keeps each batch from rescanning the rows the rule
 * skips (unread or other-type rows in the read-`go_live` band); it is inclusive because rows can
 * share a timestamp, and still walks `notifications_created_idx` in index order. Returns the count
 * and the next bound as text, so microseconds survive the round trip.
 */
export const pruneBatch = (where: SQL, batchSize: number, from: string | null = null): SQL => {
  const bound = from === null ? sql`` : sql` and created_at >= ${from}::timestamptz`;
  return sql`
  with d as (
    delete from notifications
     where id in (select id from notifications where ${where}${bound} order by created_at limit ${batchSize})
     returning created_at)
  select count(*)::int as n, max(created_at)::text as last from d`;
};

async function drain(ctx: WorkerContext, where: SQL, batchSize: number): Promise<number> {
  let total = 0;
  let from: string | null = null;
  for (;;) {
    const [row] = (await ctx.db.execute(pruneBatch(where, batchSize, from))) as unknown as {
      n: number;
      last: string | null;
    }[];
    const n = row?.n ?? 0;
    total += n;
    if (n < batchSize || row?.last === undefined || row.last === null) return total;
    from = row.last;
  }
}

export async function pruneNotifications(ctx: WorkerContext, opts: PruneOptions = {}): Promise<PruneResult> {
  const batchSize = opts.batchSize ?? NOTIFY_RULES.pruneBatchSize;
  const rules = pruneRules(pruneCutoffs(ctx.now(), opts.retentionDays, opts.readGoLiveRetentionDays));
  // Age first, so a read go_live row older than both windows counts once, under `deleted` only.
  const old = await drain(ctx, rules.all, batchSize);
  const readGoLive = await drain(ctx, rules.readGoLive, batchSize);
  const result = { deleted: old + readGoLive, readGoLive };
  ctx.logger.info("notifications pruned", { ...result });
  return result;
}
