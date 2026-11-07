// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Creator Analytics reads (W2-rollup-analytics, decision (k), feature-wins §4.9). Everything comes
 * from the per-broadcast rollup (`broadcast_audience_*`, `broadcast_costs`), the same rows the
 * signed attestations read, so a sponsor's statement and the creator's chart cannot disagree.
 * Revenue is read from the ledger (read-only). Output is counts, seconds, bytes and categories:
 * never a user id, a signal code or a threshold.
 */
import type {
  AnalyticsExclusions,
  AnalyticsPnl,
  AnalyticsRange,
  BroadcastAnalytics,
  IntegritySummary,
} from "@commonair/contracts/dto";
import { schema } from "@commonair/db";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import type { Deps } from "../deps.ts";
import { apiError, notFound } from "../lib/errors.ts";
import {
  type BySource,
  type ExclusionGroup,
  addInto,
  deliveryMix,
  displayCutoff,
  displayable,
  groupsOf,
  shownFollowCount,
  sumGroups,
  suppressGroups,
} from "./rules.ts";

const { broadcasts, broadcastAudienceTotals: totalsT, broadcastAudienceMinutes: minutesT, broadcastCosts } = schema;

/** Broadcasts one range read lists at most (newest first). */
export const RANGE_BROADCAST_CAP = 500;

type ReadDeps = Pick<Deps, "db" | "env" | "now">;

/**
 * PRECONDITION_FAILED `analytics_pending`: the broadcast is live, inside the 24 h display delay or
 * not rolled up yet. (The base error map's `data` carries only `requirement`; when it shows is a
 * contract request.)
 */
export const pending = () =>
  apiError("PRECONDITION_FAILED", "This broadcast's analytics are not available yet", {
    requirement: "analytics_pending",
  });

const iso = (d: Date) => d.toISOString();
const money = (cents: number, currency: string) => ({ cents, currency });

type TotalsRow = typeof totalsT.$inferSelect;

const audience = (t: TotalsRow) => ({
  verifiedViewerSeconds: t.verifiedViewerSeconds,
  unverifiedViewerSeconds: t.unverifiedViewerSeconds,
  excludedViewerSeconds: t.excludedViewerSeconds,
  peakVerifiedConcurrent: t.peakVerifiedConcurrent,
  sessions: t.sessions,
});

/** One broadcast's analytics, or NOT_FOUND / `analytics_pending`. Cost only when `withCost` (owner). */
export async function broadcastAnalytics(
  deps: ReadDeps,
  q: { channelId: string; broadcastId: string; withCost: boolean; bypassed: boolean },
): Promise<BroadcastAnalytics> {
  const [b] = await deps.db
    .select({
      id: broadcasts.id,
      title: broadcasts.title,
      startedAt: broadcasts.startedAt,
      endedAt: broadcasts.endedAt,
    })
    .from(broadcasts)
    .where(and(eq(broadcasts.id, q.broadcastId), eq(broadcasts.channelId, q.channelId), eq(broadcasts.kind, "live")));
  if (!b) throw notFound("Broadcast not found");
  if (!b.endedAt) throw pending();
  if (!displayable(b.endedAt, deps.now(), q.bypassed)) throw pending();
  const [t] = await deps.db.select().from(totalsT).where(eq(totalsT.broadcastId, b.id));
  // Not rolled up yet (it runs AUDIENCE_SETTLE_SECONDS after the end, well inside the delay).
  if (!t) throw pending();
  const minutes =
    t.minutesPurgedAt === null
      ? await deps.db.select().from(minutesT).where(eq(minutesT.broadcastId, b.id)).orderBy(asc(minutesT.minute))
      : [];
  const { shown, hidden } = suppressGroups(groupsOf(t));
  let cost: BroadcastAnalytics["cost"] = null;
  if (q.withCost) {
    const [c] = await deps.db
      .select({ cents: broadcastCosts.costCents, currency: broadcastCosts.currency })
      .from(broadcastCosts)
      .where(eq(broadcastCosts.broadcastId, b.id));
    cost = c ? money(c.cents, c.currency) : null;
  }
  return {
    broadcastId: b.id,
    title: b.title,
    startedAt: iso(b.startedAt),
    endedAt: iso(b.endedAt),
    durationSeconds: t.durationSeconds,
    totals: audience(t),
    minutes: minutes.map((m) => ({
      at: iso(m.minute),
      verified: m.verified,
      unverified: m.unverified,
      excluded: m.excluded,
    })),
    minutesRetained: t.minutesPurgedAt === null,
    exclusions: shown,
    hiddenGroups: hidden,
    delivery: deliveryMix(t.bytesBySource, t.verifiedSecondsBySource),
    cost,
  };
}

interface RangeRow {
  broadcastId: string;
  title: string;
  startedAt: Date;
  totals: TotalsRow;
  costCents: number | null;
  costCurrency: string | null;
}

/** The channel's rolled-up, displayable broadcasts that started in `[from, to)`, newest first. */
async function rangeRows(
  deps: ReadDeps,
  q: { channelId: string; from: Date; to: Date; bypassed: boolean },
): Promise<RangeRow[]> {
  const rows = await deps.db
    .select({
      broadcastId: broadcasts.id,
      title: broadcasts.title,
      startedAt: broadcasts.startedAt,
      totals: totalsT,
      costCents: broadcastCosts.costCents,
      costCurrency: broadcastCosts.currency,
    })
    .from(totalsT)
    .innerJoin(broadcasts, eq(broadcasts.id, totalsT.broadcastId))
    .leftJoin(broadcastCosts, eq(broadcastCosts.broadcastId, totalsT.broadcastId))
    .where(
      and(
        eq(totalsT.channelId, q.channelId),
        eq(broadcasts.kind, "live"),
        gte(broadcasts.startedAt, q.from),
        lt(broadcasts.startedAt, q.to),
        isNotNull(broadcasts.endedAt),
        q.bypassed ? undefined : lte(broadcasts.endedAt, displayCutoff(deps.now())),
      ),
    )
    .orderBy(desc(broadcasts.startedAt))
    .limit(RANGE_BROADCAST_CAP);
  return rows;
}

const emptyAudience = () => ({
  verifiedViewerSeconds: 0,
  unverifiedViewerSeconds: 0,
  excludedViewerSeconds: 0,
  peakVerifiedConcurrent: 0,
  sessions: 0,
});

/** The cost of the rows in the instance's cost currency (null when none has a cost row). */
function costOf(deps: ReadDeps, rows: readonly RangeRow[]) {
  const currency = deps.env.INFRA_COST_MODEL.currency;
  const priced = rows.filter((r) => r.costCents !== null && r.costCurrency === currency);
  if (priced.length === 0) return null;
  return money(
    priced.reduce((a, r) => a + (r.costCents ?? 0), 0),
    currency,
  );
}

/**
 * The channel's live broadcast, when it started before `to` (overhaul decision 2): the page's
 * "Live now" entry with the worker's running peak. It is never in the rollup rows above until it
 * has ended and settled.
 */
export async function liveEntry(
  deps: Pick<Deps, "db">,
  q: { channelId: string; to: Date },
): Promise<NonNullable<AnalyticsRange["live"]> | null> {
  const [b] = await deps.db
    .select({
      broadcastId: broadcasts.id,
      title: broadcasts.title,
      startedAt: broadcasts.startedAt,
      peakSoFar: broadcasts.peakVerifiedViewers,
    })
    .from(schema.channels)
    .innerJoin(broadcasts, eq(broadcasts.id, schema.channels.liveBroadcastId))
    .where(
      and(
        eq(schema.channels.id, q.channelId),
        eq(broadcasts.kind, "live"),
        isNull(broadcasts.endedAt),
        lt(broadcasts.startedAt, q.to),
      ),
    );
  return b ? { ...b, startedAt: iso(b.startedAt) } : null;
}

export async function rangeAnalytics(
  deps: ReadDeps,
  q: { channelId: string; from: Date; to: Date; bypassed: boolean },
): Promise<AnalyticsRange> {
  const [rows, live] = await Promise.all([rangeRows(deps, q), liveEntry(deps, q)]);
  const totals = emptyAudience();
  const bytes: BySource = {};
  const verified: BySource = {};
  for (const r of rows) {
    const a = audience(r.totals);
    totals.verifiedViewerSeconds += a.verifiedViewerSeconds;
    totals.unverifiedViewerSeconds += a.unverifiedViewerSeconds;
    totals.excludedViewerSeconds += a.excludedViewerSeconds;
    totals.sessions += a.sessions;
    totals.peakVerifiedConcurrent = Math.max(totals.peakVerifiedConcurrent, a.peakVerifiedConcurrent);
    addInto(bytes, r.totals.bytesBySource);
    addInto(verified, r.totals.verifiedSecondsBySource);
  }
  return {
    from: iso(q.from),
    to: iso(q.to),
    totals,
    broadcasts: rows.map((r) => ({
      broadcastId: r.broadcastId,
      title: r.title,
      startedAt: iso(r.startedAt),
      durationSeconds: r.totals.durationSeconds,
      totals: audience(r.totals),
    })),
    delivery: deliveryMix(bytes, verified),
    cost: costOf(deps, rows),
    live,
  };
}

/** Shown groups per broadcast (each suppressed on its own) and how many were hidden. */
function groupsByBroadcast(rows: readonly RangeRow[]) {
  const groups: (ExclusionGroup & { broadcastId: string })[] = [];
  let hidden = 0;
  for (const r of rows) {
    const s = suppressGroups(groupsOf(r.totals));
    hidden += s.hidden;
    for (const g of s.shown) groups.push({ ...g, broadcastId: r.broadcastId });
  }
  return { groups, hidden };
}

export async function exclusionsAnalytics(
  deps: ReadDeps,
  q: { channelId: string; from: Date; to: Date; bypassed: boolean },
): Promise<AnalyticsExclusions> {
  const { groups, hidden } = groupsByBroadcast(await rangeRows(deps, q));
  return { from: iso(q.from), to: iso(q.to), groups, hiddenGroups: hidden };
}

/** Ledger kinds that are revenue (net of refunds and chargebacks), as `monthlyAggregates` counts them. */
const REVENUE_KINDS = ["payment", "refund", "chargeback", "chargeback_reversal"] as const;

/**
 * The owner's creator-side revenue lines (`liability:creator`, `liability:creator-hold`,
 * `asset:receivable:creator`) of the revenue kinds, on ledger alias `e`/`a`/`t`; credits are
 * revenue, so sums are negated.
 */
const revenueLines = (ownerId: string, currency: string) => sql`
  a.owner_user_id = ${ownerId}
  and e.currency = ${currency}
  and (a.code like 'liability:creator:%' or a.code like 'liability:creator-hold:%'
       or a.code like 'asset:receivable:creator:%')
  and t.kind in (${sql.join(
    REVENUE_KINDS.map((k) => sql`${k}`),
    sql`, `,
  )})`;

/**
 * Revenue in `[from, to)` and, per listed broadcast, the revenue posted while it was live
 * (`[startedAt, endedAt)`: tips and subscriptions during the stream).
 */
async function revenue(
  deps: ReadDeps,
  q: { ownerId: string; currency: string; from: Date; to: Date; broadcastIds: readonly string[] },
): Promise<{ total: number; byBroadcast: Map<string, number> }> {
  const [total] = (await deps.db.execute(sql`
    select coalesce(-sum(e.amount_cents), 0)::text as cents
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
     where ${revenueLines(q.ownerId, q.currency)}
       and t.occurred_at >= ${iso(q.from)}::timestamptz and t.occurred_at < ${iso(q.to)}::timestamptz`)) as unknown as {
    cents: string;
  }[];
  const byBroadcast = new Map<string, number>();
  if (q.broadcastIds.length > 0) {
    const rows = (await deps.db.execute(sql`
      select b.id::text as broadcast_id, coalesce(-sum(e.amount_cents), 0)::text as cents
        from broadcasts b
        join ledger_transactions t on t.occurred_at >= b.started_at and t.occurred_at < b.ended_at
        join ledger_entries e on e.transaction_id = t.id
        join ledger_accounts a on a.id = e.account_id
       where b.id in (${sql.join(
         q.broadcastIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
         and ${revenueLines(q.ownerId, q.currency)}
       group by b.id`)) as unknown as { broadcast_id: string; cents: string }[];
    for (const r of rows) byBroadcast.set(r.broadcast_id, Number(r.cents));
  }
  return { total: Number(total?.cents ?? 0), byBroadcast };
}

export async function pnlAnalytics(
  deps: ReadDeps,
  q: { channelId: string; ownerId: string; from: Date; to: Date; bypassed: boolean },
): Promise<AnalyticsPnl> {
  const currency = deps.env.INFRA_COST_MODEL.currency;
  const rows = await rangeRows(deps, q);
  const rev = await revenue(deps, {
    ownerId: q.ownerId,
    currency,
    from: q.from,
    to: q.to,
    broadcastIds: rows.map((r) => r.broadcastId),
  });
  const cost = costOf(deps, rows)?.cents ?? 0;
  return {
    from: iso(q.from),
    to: iso(q.to),
    revenue: money(rev.total, currency),
    cost: money(cost, currency),
    net: money(rev.total - cost, currency),
    byBroadcast: rows.map((r) => ({
      broadcastId: r.broadcastId,
      revenue: money(rev.byBroadcast.get(r.broadcastId) ?? 0, currency),
      cost: money(r.costCurrency === currency ? (r.costCents ?? 0) : 0, currency),
    })),
  };
}

/** `integrity.channelSummary`: what was excluded from the channel's counts in `[from, to)`, and why. */
export async function channelSummary(
  deps: ReadDeps,
  q: { channelId: string; channelSlug: string; from: Date; to: Date; bypassed: boolean },
): Promise<z.output<typeof IntegritySummary>> {
  const rows = await rangeRows(deps, q);
  const { groups, hidden } = groupsByBroadcast(rows);
  const [follows] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.follows)
    .where(
      and(
        eq(schema.follows.channelId, q.channelId),
        gte(schema.follows.excludedAt, q.from),
        lt(schema.follows.excludedAt, q.to),
        // The same 24 h delay as the broadcasts: a fresh exclusion is not shown yet.
        q.bypassed ? undefined : lte(schema.follows.excludedAt, displayCutoff(deps.now())),
      ),
    );
  const sum = (k: "verifiedViewerSeconds" | "unverifiedViewerSeconds" | "excludedViewerSeconds") =>
    rows.reduce((a, r) => a + r.totals[k], 0);
  return {
    channelSlug: q.channelSlug,
    periodStart: iso(q.from),
    periodEnd: iso(q.to),
    verifiedViewerSeconds: sum("verifiedViewerSeconds"),
    unverifiedViewerSeconds: sum("unverifiedViewerSeconds"),
    excludedViewerSeconds: sum("excludedViewerSeconds"),
    excludedFollows: shownFollowCount(follows?.n ?? 0),
    exclusionsByCategory: sumGroups(groups),
    hiddenGroups: hidden,
  };
}

/** The channel's broadcast of kind `live` with its end (null while live), or null (share links). */
export async function endedBroadcast(deps: Pick<Deps, "db">, channelId: string, broadcastId: string) {
  const [b] = await deps.db
    .select({ id: broadcasts.id, endedAt: broadcasts.endedAt })
    .from(broadcasts)
    .where(and(eq(broadcasts.id, broadcastId), eq(broadcasts.channelId, channelId), eq(broadcasts.kind, "live")));
  return b ?? null;
}
