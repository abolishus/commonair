// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Patronage inputs from the system of record. Only verified facts count: eligible stream
 * hours (≥ 1 verified viewer other than the streamer), verified relay receipts, verified
 * playback sessions, and ledger revenue. Periods are half-open [start, end) in UTC.
 */
import { type SQL, sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { assertCurrency } from "@commonair/ledger";
import type { MemberInputs } from "./formula.ts";

export interface Period {
  start: Date;
  end: Date;
}

function assertPeriod(p: Period): void {
  if (Number.isNaN(p.start.getTime()) || Number.isNaN(p.end.getTime()) || !(p.start < p.end)) {
    throw new RangeError("period start must be before its end");
  }
}

const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** Members who receive patronage: an active membership (any class) at the period end, per the membership history. */
export async function eligibleMembers(db: Executor, periodEnd: Date): Promise<string[]> {
  const rows = await db.execute<{ user_id: string }>(sql`
    select distinct h.user_id from (
      select distinct on (membership_id) membership_id, user_id, status
      from membership_history where at <= ${iso(periodEnd)}
      order by membership_id, at desc
    ) h where h.status = 'active'
    order by h.user_id`);
  return [...rows].map((r) => r.user_id);
}

/** Eligible streaming hours per member: per UTC day, live hours capped at `dailyCap`, summed. */
export async function streamingHoursByMember(
  db: Executor,
  userIds: readonly string[],
  period: Period,
  dailyCap: number,
): Promise<Map<string, number>> {
  assertPeriod(period);
  if (!(dailyCap > 0)) throw new RangeError("dailyStreamingHourCap must be positive");
  if (userIds.length === 0) return new Map();
  const rows = await db.execute<{ user_id: string; hours: number | string }>(sql`
    select c.owner_id as user_id, sum(least(d.secs / 3600.0, ${dailyCap}))::float8 as hours
    from (
      select sh.channel_id, date_trunc('day', sh.hour_start at time zone 'UTC') as day, sum(sh.live_seconds) as secs
      from stream_hours sh
      where sh.eligible and sh.verified_other_viewers >= 1
        and sh.hour_start >= ${iso(period.start)} and sh.hour_start < ${iso(period.end)}
      group by 1, 2
    ) d join channels c on c.id = d.channel_id
    where c.owner_id in (${idList(userIds)})
    group by c.owner_id`);
  return new Map([...rows].map((r) => [r.user_id, Number(r.hours)]));
}

/** Verified relay bytes per member, over the relays they own. */
export async function relayBytesByMember(
  db: Executor,
  userIds: readonly string[],
  period: Period,
): Promise<Map<string, number>> {
  assertPeriod(period);
  if (userIds.length === 0) return new Map();
  const rows = await db.execute<{ user_id: string; bytes: string }>(sql`
    select n.owner_id as user_id, sum(r.bytes_verified)::text as bytes
    from relay_receipts r join relay_nodes n on n.id = r.relay_id
    where r.status = 'verified'
      and r.period_start >= ${iso(period.start)} and r.period_start < ${iso(period.end)}
      and n.owner_id in (${idList(userIds)})
    group by n.owner_id`);
  return new Map([...rows].map((r) => [r.user_id, Number(r.bytes)]));
}

/**
 * Viewer-hours per channel owner: gate-eligible verified sessions (scored at least once and
 * fetch-judged, the same rule as `GATE_ELIGIBLE` in @commonair/integrity, so an unjudged CDN
 * session earns nothing; the owner watching themselves never counts) and, for the statement,
 * excluded sessions.
 */
export async function viewerHoursByMember(
  db: Executor,
  userIds: readonly string[],
  period: Period,
): Promise<Map<string, { verified: number; excluded: number }>> {
  assertPeriod(period);
  if (userIds.length === 0) return new Map();
  const rows = await db.execute<{ user_id: string; verified: number | string; excluded: number | string }>(sql`
    select c.owner_id as user_id,
      (coalesce(sum(ps.watch_seconds) filter (
        where ps.verdict = 'verified' and ps.scored_at is not null
          and not ('fetch_unjudged' = any(coalesce(ps.verdict_reasons, '{}')))
          and ps.user_id is distinct from c.owner_id), 0) / 3600.0)::float8 as verified,
      (coalesce(sum(ps.watch_seconds) filter (where ps.verdict = 'excluded'), 0) / 3600.0)::float8 as excluded
    from playback_sessions ps join channels c on c.id = ps.channel_id
    where ps.started_at >= ${iso(period.start)} and ps.started_at < ${iso(period.end)}
      and c.owner_id in (${idList(userIds)})
    group by c.owner_id`);
  return new Map([...rows].map((r) => [r.user_id, { verified: Number(r.verified), excluded: Number(r.excluded) }]));
}

/**
 * Revenue per channel owner from the ledger: subscription and tip gross (incl. tax), net of
 * refunds and chargebacks posted in the period, as recorded by the ledger posting rules.
 */
export async function revenueByMember(
  db: Executor,
  userIds: readonly string[],
  period: Period,
  currency: string,
): Promise<Map<string, number>> {
  assertPeriod(period);
  assertCurrency(currency);
  if (userIds.length === 0) return new Map();
  const rows = await db.execute<{ user_id: string; cents: string }>(sql`
    select t.metadata->>'creatorUserId' as user_id, sum((t.metadata->>'revenueGrossCents')::bigint)::text as cents
    from ledger_transactions t
    where t.kind in ('payment', 'refund', 'chargeback', 'chargeback_reversal')
      and t.occurred_at >= ${iso(period.start)} and t.occurred_at < ${iso(period.end)}
      and t.metadata->>'creatorUserId' in (${sql.join(
        userIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      and exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.currency = ${currency})
    group by 1`);
  return new Map([...rows].map((r) => [r.user_id, Number(r.cents)]));
}

/** All inputs for the given members (members with no activity get zeros). */
export async function collectInputs(
  db: Executor,
  userIds: readonly string[],
  period: Period,
  opts: { currency: string; dailyStreamingHourCap: number },
): Promise<MemberInputs[]> {
  const [hours, relay, viewers, revenue] = await Promise.all([
    streamingHoursByMember(db, userIds, period, opts.dailyStreamingHourCap),
    relayBytesByMember(db, userIds, period),
    viewerHoursByMember(db, userIds, period),
    revenueByMember(db, userIds, period, opts.currency),
  ]);
  return userIds.map((userId) => ({
    userId,
    revenueCents: Math.max(0, revenue.get(userId) ?? 0),
    eligibleStreamingHours: hours.get(userId) ?? 0,
    relayBytesVerified: relay.get(userId) ?? 0,
    viewerHoursVerified: viewers.get(userId)?.verified ?? 0,
    viewerHoursExcluded: viewers.get(userId)?.excluded ?? 0,
  }));
}

/** Single-member conveniences (statements, eligibility checks). */
export async function eligibleStreamingHours(
  db: Executor,
  userId: string,
  period: Period,
  dailyCap = 8,
): Promise<number> {
  return (await streamingHoursByMember(db, [userId], period, dailyCap)).get(userId) ?? 0;
}
export async function relayBytesVerified(db: Executor, userId: string, period: Period): Promise<number> {
  return (await relayBytesByMember(db, [userId], period)).get(userId) ?? 0;
}
export async function viewerHours(
  db: Executor,
  userId: string,
  period: Period,
): Promise<{ verified: number; excluded: number }> {
  return (await viewerHoursByMember(db, [userId], period)).get(userId) ?? { verified: 0, excluded: 0 };
}
export async function revenueCents(db: Executor, userId: string, period: Period, currency: string): Promise<number> {
  return (await revenueByMember(db, [userId], period, currency)).get(userId) ?? 0;
}
