// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contribution inputs read from the database, per member, over a time window. The
 * definitions match the patronage inputs (packages/patronage) so that council seating
 * and patronage measure contribution the same way.
 */
import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";

export interface ContributionInput {
  userId: string;
  /** Gross subscription + tip revenue net of tax and refunds, in cents. */
  revenueCents: number;
  /** Eligible streaming hours (≥ 1 verified viewer other than the streamer), capped per UTC day. */
  eligibleHours: number;
  /** Verified relay bytes served by relays the member owns. */
  relayBytes: number;
  /** Verified viewer-hours watched on the member's channel. */
  viewerHours: number;
}

type Row = Record<string, unknown>;
/** postgres.js cannot bind Date objects inside raw `sql` fragments; pass ISO text with a cast. */
export const tsz = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const rowsOf = (result: unknown): Row[] => result as Row[];
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Eligible streaming hours per channel owner in [from, to), each UTC day capped at `dailyCap` hours. */
export async function eligibleHoursByUser(
  db: Executor,
  from: Date,
  to: Date,
  dailyCap: number,
): Promise<Map<string, number>> {
  const rows = rowsOf(
    await db.execute(sql`
      select c.owner_id as user_id, sum(least(d.day_seconds / 3600.0, ${dailyCap}::float8)) as hours
        from (select sh.channel_id, date_trunc('day', sh.hour_start, 'UTC') as day, sum(sh.live_seconds) as day_seconds
                from stream_hours sh
               where sh.eligible and sh.hour_start >= ${tsz(from)} and sh.hour_start < ${tsz(to)}
               group by 1, 2) d
        join channels c on c.id = d.channel_id
       group by c.owner_id`),
  );
  return new Map(rows.map((r) => [String(r.user_id), num(r.hours)]));
}

/** A uuid[] parameter. Ids must be uuids (callers pass database ids); a malformed one fails the cast. */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

/**
 * The query behind `eligibleHoursForUsers`, exported so a test can `explain` it. It starts from
 * the owners' channels (`channels.owner_id` is unique) and range-scans `stream_hours_channel_idx`
 * per channel instead of aggregating every owner's hours.
 */
export const eligibleHoursForUsersSql = (userIds: readonly string[], from: Date, to: Date, dailyCap: number) => sql`
  select d.user_id, sum(least(d.day_seconds / 3600.0, ${dailyCap}::float8)) as hours
    from (select c.owner_id as user_id, sh.channel_id, date_trunc('day', sh.hour_start, 'UTC') as day,
                 sum(sh.live_seconds) as day_seconds
            from channels c
            join stream_hours sh on sh.channel_id = c.id
           where c.owner_id = any(${uuidArray(userIds)})
             and sh.eligible and sh.hour_start >= ${tsz(from)} and sh.hour_start < ${tsz(to)}
           group by 1, 2, 3) d
   group by d.user_id`;

/**
 * `eligibleHoursByUser` restricted to `userIds`: the same per-day cap and window, for a caller that
 * needs a few users (the membership view) rather than every channel owner (the sync).
 */
export async function eligibleHoursForUsers(
  db: Executor,
  userIds: readonly string[],
  from: Date,
  to: Date,
  dailyCap: number,
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = rowsOf(await db.execute(eligibleHoursForUsersSql(userIds, from, to, dailyCap)));
  return new Map(rows.map((r) => [String(r.user_id), num(r.hours)]));
}

/** Every contribution component per user in [from, to). Users with no contribution are absent. */
export async function contributionInputs(
  db: Executor,
  from: Date,
  to: Date,
  dailyCap: number,
): Promise<Map<string, ContributionInput>> {
  const out = new Map<string, ContributionInput>();
  const get = (userId: string) => {
    let v = out.get(userId);
    if (!v) {
      v = { userId, revenueCents: 0, eligibleHours: 0, relayBytes: 0, viewerHours: 0 };
      out.set(userId, v);
    }
    return v;
  };
  for (const [userId, hours] of await eligibleHoursByUser(db, from, to, dailyCap)) get(userId).eligibleHours = hours;

  const revenue = rowsOf(
    await db.execute(sql`
      select c.owner_id as user_id,
             sum(greatest(p.amount_cents - p.tax_cents - p.refunded_cents, 0)) as cents
        from payments p join channels c on c.id = p.channel_id
       where p.kind in ('subscription', 'tip') and p.status in ('succeeded', 'partially_refunded')
         and p.succeeded_at >= ${tsz(from)} and p.succeeded_at < ${tsz(to)}
       group by c.owner_id`),
  );
  for (const r of revenue) get(String(r.user_id)).revenueCents = num(r.cents);

  const relay = rowsOf(
    await db.execute(sql`
      select n.owner_id as user_id, sum(r.bytes_verified) as bytes
        from relay_receipts r join relay_nodes n on n.id = r.relay_id
       where r.status = 'verified' and r.period_start >= ${tsz(from)} and r.period_start < ${tsz(to)}
       group by n.owner_id`),
  );
  for (const r of relay) get(String(r.user_id)).relayBytes = num(r.bytes);

  // Gate-eligible sessions only (`GATE_ELIGIBLE` in @commonair/integrity): an unjudged CDN
  // session earns no eligibility.
  const viewers = rowsOf(
    await db.execute(sql`
      select c.owner_id as user_id, sum(s.watch_seconds) / 3600.0 as hours
        from playback_sessions s join channels c on c.id = s.channel_id
       where s.verdict = 'verified' and s.scored_at is not null
         and not ('fetch_unjudged' = any(coalesce(s.verdict_reasons, '{}')))
         and s.started_at >= ${tsz(from)} and s.started_at < ${tsz(to)}
       group by c.owner_id`),
  );
  for (const r of viewers) get(String(r.user_id)).viewerHours = num(r.hours);
  return out;
}
