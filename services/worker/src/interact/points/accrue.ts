// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `points-accrue` (ADR 0026 decision 1): credit channel points for gate-eligible watch time only,
 * so a viewbot swarm, an anonymous viewer or a session behind an unjudged CDN path earns nothing.
 *
 * Per (channel, viewer), one transaction: lock (or create) the `loyalty_accruals` row, re-read the
 * sessions' growth under that lock, apply the block math, post one `watch` ledger row when points
 * are due (no event: passive accrual is not announced) and raise every contributing session's
 * high-water mark (`loyalty_accrual_sessions.counted_seconds`) to the watch seconds it read. The
 * lock and the re-read make a second, concurrent run (the test hook) credit nothing twice. No
 * clawback: a verdict that changes after a credit leaves the points where they are.
 *
 * A session that grows while its viewer may not earn there (points off on the channel, or a
 * platform suspension) has its high-water mark raised with no credit on every run, so that time is
 * never credited once points come back on or the suspension ends.
 *
 * Skipped: the channel's own owner, bot accounts, platform-suspended and deleted accounts, channels
 * whose points are off, and demo data (a demo channel's viewers and a demo viewer anywhere; the
 * `demo:clear` two-anchor rule), because a `loyalty_transactions` row is append-only and
 * `restrict`, so one on demo data would make `demo:clear` fail as a whole.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { anchoredUser, postPointsInTx, schema as s, type Database } from "@commonair/db";
import { GATE_ELIGIBLE } from "@commonair/integrity";
import { accrue, creditableSeconds, readPointsAccrual, utcDay } from "@commonair/interact";
import type { Logger } from "@commonair/observability";

/** Sessions scored this recently are candidates (`playback_sessions_points_idx` covers the filter). */
export const SCORED_LOOKBACK_MS = 6 * 3_600_000;
/** Candidate (channel, viewer) pairs read per query. */
export const ACCRUAL_BATCH = 500;
/** Pairs one run handles at most; the next run continues (it starts every 60 s). */
export const ACCRUAL_MAX_VIEWERS = 5_000;

export interface AccrueOptions {
  now?: Date;
  batchSize?: number;
  maxViewers?: number;
}

export interface AccrueResult {
  /** Viewers (per channel) credited at least one point. */
  viewers: number;
  points: number;
}

interface Candidate {
  channelId: string;
  userId: string;
  sessionIds: string[];
}

/** postgres.js cannot bind Date objects inside raw `sql` fragments; pass ISO text with a cast. */
const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

const POINTS_OFF = sql`coalesce(bc.config->'loyalty'->>'enabled', 'true') = 'false'`;
const SUSPENDED = (now: Date): SQL => sql`(u.banned and (u.ban_expires is null or u.ban_expires > ${tsz(now)}))`;

/**
 * Raise the high-water mark, with no credit, of every recently scored session whose viewer may not
 * earn on its channel right now (any verdict: a pending session verified later must not earn for
 * this time either). With `everyone` (the daily cap is 0, so nobody earns) every such session is
 * marked, so raising the cap later does not pay out the time before it.
 */
async function markUnearnable(db: Database, now: Date, everyone: boolean): Promise<void> {
  const since = new Date(now.getTime() - SCORED_LOOKBACK_MS);
  await db.execute(sql`
    insert into loyalty_accrual_sessions (session_id, counted_seconds, updated_at)
    select ps.id, ps.watch_seconds, ${tsz(now)}
      from playback_sessions ps
      join users u on u.id = ps.user_id
      left join loyalty_accrual_sessions las on las.session_id = ps.id
      left join bot_configs bc on bc.channel_id = ps.channel_id
     where ps.user_id is not null
       and ps.scored_at >= ${tsz(since)}
       and ps.watch_seconds > coalesce(las.counted_seconds, 0)
       and (${everyone ? sql`true` : sql`false`} or ${POINTS_OFF} or ${SUSPENDED(now)})
    on conflict (session_id) do update
       set counted_seconds = greatest(loyalty_accrual_sessions.counted_seconds, excluded.counted_seconds),
           updated_at = excluded.updated_at`);
}

/** Who may earn on which channel: everything but the time itself (see the module comment). */
function candidates(now: Date, after: { channelId: string; userId: string } | null, limit: number): SQL {
  const since = new Date(now.getTime() - SCORED_LOOKBACK_MS);
  const cursor = after
    ? sql`and (ps.channel_id, ps.user_id) > (${after.channelId}::uuid, ${after.userId}::uuid)`
    : sql``;
  return sql`
    select ps.channel_id as "channelId", ps.user_id as "userId",
           array_agg(ps.id::text order by ps.id) as "sessionIds"
      from playback_sessions ps
      join channels c on c.id = ps.channel_id
      join users u on u.id = ps.user_id
      left join loyalty_accrual_sessions las on las.session_id = ps.id
      left join bot_configs bc on bc.channel_id = ps.channel_id
     where ps.user_id is not null
       and ps.verdict = 'verified'
       and ps.scored_at >= ${tsz(since)}
       and ${GATE_ELIGIBLE}
       and ps.watch_seconds > coalesce(las.counted_seconds, 0)
       and ps.user_id <> c.owner_id
       and u.account_type <> 'bot'
       and u.deleted_at is null
       and not ${SUSPENDED(now)}
       and not ${POINTS_OFF}
       and not exists (select 1 from users where users.id = c.owner_id and ${anchoredUser()})
       and not exists (select 1 from users where users.id = ps.user_id and ${anchoredUser()})
       ${cursor}
     group by ps.channel_id, ps.user_id
     order by ps.channel_id, ps.user_id
     limit ${limit}`;
}

/** Credit one viewer on one channel; returns the points credited. */
async function accrueOne(
  db: Database,
  c: Candidate,
  setting: Awaited<ReturnType<typeof readPointsAccrual>>,
  now: Date,
): Promise<number> {
  return db.transaction(async (tx) => {
    const key = and(eq(s.loyaltyAccruals.channelId, c.channelId), eq(s.loyaltyAccruals.userId, c.userId));
    const created = await tx
      .insert(s.loyaltyAccruals)
      .values({ channelId: c.channelId, userId: c.userId, day: utcDay(now), updatedAt: now })
      .onConflictDoNothing()
      .returning({ channelId: s.loyaltyAccruals.channelId });
    const [state] = await tx.select().from(s.loyaltyAccruals).where(key).for("update");
    if (!state) throw new Error("loyalty_accruals row vanished under its lock");

    // Re-read under the lock: a concurrent run that got here first has raised the marks.
    const sessions = await tx
      .select({
        id: s.playbackSessions.id,
        watch: s.playbackSessions.watchSeconds,
        counted: sql<number>`coalesce(${s.loyaltyAccrualSessions.countedSeconds}, 0)`.mapWith(Number),
        startedAt: s.playbackSessions.startedAt,
      })
      .from(s.playbackSessions)
      .leftJoin(s.loyaltyAccrualSessions, eq(s.loyaltyAccrualSessions.sessionId, s.playbackSessions.id))
      .where(inArray(s.playbackSessions.id, c.sessionIds));
    const grown = sessions.filter((x) => x.watch > x.counted);
    if (grown.length === 0) return 0;

    // No window on a first run, or when every growing session started after the last credit:
    // then the sessions may have run side by side all along, so only the largest counts.
    const firstStart = Math.min(...grown.map((x) => x.startedAt.getTime()));
    const sinceLastRun =
      created.length > 0 || state.updatedAt.getTime() < firstStart
        ? null
        : (now.getTime() - state.updatedAt.getTime()) / 1000;
    const seconds = creditableSeconds(
      grown.map((x) => x.watch - x.counted),
      sinceLastRun,
    );
    const { state: next, points } = accrue(setting, state, seconds, now);
    if (points > 0)
      await postPointsInTx(tx, {
        channelId: c.channelId,
        userId: c.userId,
        delta: points,
        reason: "watch",
        refId: null,
        at: now,
      });
    await tx
      .update(s.loyaltyAccruals)
      .set({ carrySeconds: next.carrySeconds, day: next.day, dayPoints: next.dayPoints, updatedAt: now })
      .where(key);
    await tx
      .insert(s.loyaltyAccrualSessions)
      .values(grown.map((x) => ({ sessionId: x.id, countedSeconds: x.watch, updatedAt: now })))
      .onConflictDoUpdate({
        target: s.loyaltyAccrualSessions.sessionId,
        set: {
          countedSeconds: sql`greatest(${s.loyaltyAccrualSessions.countedSeconds}, excluded.counted_seconds)`,
          updatedAt: now,
        },
      });
    return points;
  });
}

/** One `points-accrue` run. */
export async function accruePoints(
  ctx: { db: Database; logger: Pick<Logger, "error" | "warn"> },
  opts: AccrueOptions = {},
): Promise<AccrueResult> {
  const now = opts.now ?? new Date();
  const batch = Math.max(1, opts.batchSize ?? ACCRUAL_BATCH);
  const max = Math.max(1, opts.maxViewers ?? ACCRUAL_MAX_VIEWERS);
  const setting = await readPointsAccrual(ctx.db, ctx.logger);
  const result: AccrueResult = { viewers: 0, points: 0 };
  await markUnearnable(ctx.db, now, setting.dailyCapPerChannel === 0);
  if (setting.dailyCapPerChannel === 0) return result;

  let after: { channelId: string; userId: string } | null = null;
  let handled = 0;
  for (;;) {
    const limit = Math.min(batch, max - handled);
    if (limit <= 0) {
      const more = (await ctx.db.execute(candidates(now, after, 1))) as unknown as Candidate[];
      if (more.length > 0) ctx.logger.warn("points accrual stopped early; the next run continues", { handled, max });
      break;
    }
    const rows = (await ctx.db.execute(candidates(now, after, limit))) as unknown as Candidate[];
    for (const c of rows) {
      const points = await accrueOne(ctx.db, c, setting, now);
      if (points > 0) {
        result.viewers++;
        result.points += points;
      }
    }
    handled += rows.length;
    const last = rows.at(-1);
    if (rows.length < limit || !last) break;
    after = { channelId: last.channelId, userId: last.userId };
  }
  return result;
}
