// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The nightly growth funnel (overhaul wave 2, D2.8; growth-funnels.md P7 A): one `growth_daily`
 * row per UTC day and metric, counted from rows the platform already keeps. Nothing about a person
 * leaves these queries: each returns a single count.
 *
 * A metric is counted on the day its step happened ("first follow on day d, within 7 days of the
 * account"), so a finished day keeps its value. Two are levels on the day instead:
 * `active_streamers` (channels live at least once in the 30 days up to the day's end) and
 * `members_total` (members at the day's end).
 *
 * Each run recomputes the last `SETTLE_DAYS` days, so a late email verification still lands on the
 * day the account was made, and fills any day of the last `BACKFILL_DAYS` missing a metric. Writes
 * are upserts, so a rerun is harmless. Recomputing stays inside both horizons: chat older than
 * the chat retention window is gone, but a first chat within 7 days of an account made in the
 * settle window is always younger than that.
 */
import { GROWTH_METRICS, type GrowthMetric } from "@commonair/contracts/enums";
import type postgres from "postgres";

const DAY_MS = 86_400_000;

/** Days before today recomputed on every run. */
export const SETTLE_DAYS = 8;
/** How far back a missing day is filled. */
export const BACKFILL_DAYS = 30;

/** The UTC calendar day of `at`, `YYYY-MM-DD`. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
const dayStart = (day: string): Date => new Date(`${day}T00:00:00Z`);
const addDays = (day: string, n: number): string => utcDay(new Date(dayStart(day).getTime() + n * DAY_MS));

type Sql = postgres.Sql;
/** `start` and `end` are ISO timestamps (the driver binds strings; each use casts to timestamptz). */
type Count = (sql: Sql, start: string, end: string) => Promise<number>;

async function one(rows: PromiseLike<readonly postgres.Row[]>): Promise<number> {
  const [r] = await rows;
  return Number(r?.n ?? 0);
}

/** First time a user did something, kept to accounts made at most `withinDays` before the window. */
function firstWithin(
  source: (sql: Sql, since: string, end: string) => postgres.PendingQuery<postgres.Row[]>,
  withinDays: number,
): Count {
  return (sql, start, end) => {
    const since = new Date(Date.parse(start) - withinDays * DAY_MS).toISOString();
    return one(sql`
      with firsts as (${source(sql, since, end)})
      select count(*)::int as n
      from firsts f join users u on u.id = f.user_id
      where u.account_type = 'human'
        and f.first_at >= ${start}::timestamptz and f.first_at < ${end}::timestamptz
        and f.first_at < u.created_at + make_interval(days => ${withinDays})`);
  };
}

/** A query for each metric over the day `[start, end)`. */
export const COUNTS: Record<GrowthMetric, Count> = {
  accounts_created: (sql, start, end) =>
    one(sql`select count(*)::int as n from users
      where account_type = 'human' and created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz`),
  accounts_verified: (sql, start, end) =>
    one(sql`select count(*)::int as n from users
      where account_type = 'human' and email_verified and created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz`),
  first_follow_within_7d: firstWithin(
    (sql, since, end) => sql`
      select f.follower_id as user_id, min(f.created_at) as first_at from follows f
      where f.follower_id in (select id from users where created_at >= ${since}::timestamptz and created_at < ${end}::timestamptz)
      group by f.follower_id`,
    7,
  ),
  first_chat_within_7d: firstWithin(
    (sql, since, end) => sql`
      select m.user_id, min(m.created_at) as first_at from chat_messages m
      where m.user_id in (select id from users where created_at >= ${since}::timestamptz and created_at < ${end}::timestamptz)
      group by m.user_id`,
    7,
  ),
  first_support_within_30d: firstWithin(
    (sql, since, end) => sql`
      select p.user_id, min(p.succeeded_at) as first_at from payments p
      where p.kind in ('subscription', 'tip') and p.succeeded_at is not null
        and p.user_id in (select id from users where created_at >= ${since}::timestamptz and created_at < ${end}::timestamptz)
      group by p.user_id`,
    30,
  ),
  became_member: (sql, start, end) =>
    one(sql`select count(*)::int as n from (
        select user_id, min(joined_at) as first_at from memberships group by user_id
      ) m where m.first_at >= ${start}::timestamptz and m.first_at < ${end}::timestamptz`),
  // Turned an alert on by email or push, or registered a browser for push, that day.
  notify_optin: (sql, start, end) =>
    one(sql`select count(distinct x.user_id)::int as n from (
        select user_id from notification_preferences
          where enabled and medium in ('email', 'push') and updated_at >= ${start}::timestamptz and updated_at < ${end}::timestamptz
        union
        select user_id from push_subscriptions where created_at >= ${start}::timestamptz and created_at < ${end}::timestamptz
      ) x join users u on u.id = x.user_id where u.account_type = 'human'`),
  first_live: (sql, start, end) =>
    one(sql`select count(*)::int as n from (
        select channel_id, min(started_at) as first_at from broadcasts where kind = 'live' group by channel_id
      ) b where b.first_at >= ${start}::timestamptz and b.first_at < ${end}::timestamptz`),
  // The next stream that starts at least an hour after the first one (a reconnect is not a return).
  second_live_within_14d: (sql, start, end) =>
    one(sql`with firsts as (
        select channel_id, min(started_at) as first_at from broadcasts where kind = 'live' group by channel_id
      ), seconds as (
        select f.channel_id, f.first_at, min(b.started_at) as second_at
        from firsts f join broadcasts b
          on b.channel_id = f.channel_id and b.kind = 'live' and b.started_at >= f.first_at + interval '1 hour'
        group by f.channel_id, f.first_at
      )
      select count(*)::int as n from seconds
      where second_at >= ${start}::timestamptz and second_at < ${end}::timestamptz and second_at < first_at + interval '14 days'`),
  imports_finished: (sql, start, end) =>
    one(sql`select count(*)::int as n from portability_imports
      where status = 'done' and finished_at >= ${start}::timestamptz and finished_at < ${end}::timestamptz`),
  active_streamers: (sql, _start, end) =>
    one(sql`select count(distinct channel_id)::int as n from broadcasts
      where kind = 'live' and started_at < ${end}::timestamptz
        and coalesce(ended_at, ${end}::timestamptz) > ${new Date(Date.parse(end) - 30 * DAY_MS).toISOString()}::timestamptz`),
  // least() skips nulls: a membership counts until it lapsed or ended, whichever came first.
  members_total: (sql, _start, end) =>
    one(sql`select count(distinct user_id)::int as n from memberships
      where joined_at < ${end}::timestamptz and (least(lapsed_at, exited_at) is null or least(lapsed_at, exited_at) >= ${end}::timestamptz)`),
};

/** Every metric for one UTC day. */
export async function computeDay(sql: Sql, day: string): Promise<Record<GrowthMetric, number>> {
  const start = dayStart(day).toISOString();
  const end = new Date(dayStart(day).getTime() + DAY_MS).toISOString();
  const out = {} as Record<GrowthMetric, number>;
  for (const metric of GROWTH_METRICS) out[metric] = await COUNTS[metric](sql, start, end);
  return out;
}

/** The days a run at `now` computes: the settle window, plus any older day of the backfill window missing a metric. */
export async function daysToCompute(sql: Sql, now: Date): Promise<string[]> {
  const today = utcDay(now);
  const oldest = addDays(today, -BACKFILL_DAYS);
  const rows = await sql<{ day: string; n: number }[]>`
    select day::text as day, count(*)::int as n from growth_daily
    where day >= ${oldest}::date and day < ${today}::date group by day`;
  const complete = new Set(rows.filter((r) => Number(r.n) >= GROWTH_METRICS.length).map((r) => r.day));
  const days: string[] = [];
  for (let i = BACKFILL_DAYS; i >= 1; i--) {
    const day = addDays(today, -i);
    if (i <= SETTLE_DAYS || !complete.has(day)) days.push(day);
  }
  return days;
}

/** Upsert one day's metrics. */
export async function writeDay(sql: Sql, day: string, values: Record<GrowthMetric, number>): Promise<void> {
  const rows = GROWTH_METRICS.map((metric) => ({ day, metric, value: values[metric] }));
  await sql`
    insert into growth_daily ${sql(rows, "day", "metric", "value")}
    on conflict (day, metric) do update set value = excluded.value, updated_at = now()`;
}

/** One nightly run: compute and write every due day, oldest first. */
export async function runGrowthDaily(sql: Sql, now: Date): Promise<{ days: number }> {
  const days = await daysToCompute(sql, now);
  for (const day of days) await writeDay(sql, day, await computeDay(sql, day));
  return { days: days.length };
}
