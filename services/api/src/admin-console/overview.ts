// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.overview` (overhaul wave 4, D7.5): open work per staff queue, for the `/admin` home.
 * Aggregates only (counts and the oldest open item's time), one query per queue the caller's role
 * can open, never rows. A queue's roles match the procedures that open it, so the home never
 * shows a count the caller could not act on.
 */
import { ADMIN_QUEUES, type AdminQueue, type PLATFORM_ROLES } from "@commonair/contracts/enums";
import type { AdminOverview } from "@commonair/contracts/dto";
import { schema, type Executor } from "@commonair/db";
import { and, eq, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

const { moderationCases, appeals, dmcaNotices, dmcaCounterNotices, nciiRequests, integrityFlags, incidents } = schema;
const { oauthApps, payments } = schema;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** "Due soon" is within this of now (README D7.5: "due in <1 h"). */
export const DUE_SOON_MS = 60 * 60_000;
/** Apps registered this recently are the apps queue's "to look over" (there is no review state). */
export const NEW_APP_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Who may open each queue, from the access level of the procedures behind its page: the mod queue
 * (cases) for moderators and admins (`legal` has its own T0 queue), appeals and DMCA
 * (`platform-moderator`), NCII (`safety-staff`), integrity flags, incidents and apps (`admin`) and
 * the treasurer's pending payments (`finance`).
 */
const QUEUE_ROLES: Record<AdminQueue, readonly PlatformRole[]> = {
  moderation: ["moderator", "admin"],
  legal: ["legal"],
  appeals: ["moderator", "admin"],
  dmca: ["moderator", "admin"],
  ncii: ["moderator", "admin", "legal"],
  integrity: ["admin"],
  incidents: ["admin"],
  apps_review: ["admin"],
  payments: ["treasurer", "admin"],
};

/** The queues a role can open, in `ADMIN_QUEUES` order. */
export function queuesFor(role: PlatformRole): AdminQueue[] {
  return ADMIN_QUEUES.filter((q) => QUEUE_ROLES[q].includes(role));
}

type Count = AdminOverview["queues"][number];
interface Agg {
  open: number;
  overdue: number;
  dueSoon: number;
  oldestAt: Date | string | null;
  unassigned?: number | null;
}

const toCount = (queue: AdminQueue, a: Agg | undefined): Count => {
  const oldest = a?.oldestAt ?? null;
  return {
    queue,
    open: Number(a?.open ?? 0),
    overdue: Number(a?.overdue ?? 0),
    dueSoon: Number(a?.dueSoon ?? 0),
    oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
    unassigned: queue === "moderation" ? Number(a?.unassigned ?? 0) : null,
    // Contract step placeholder (overhaul wave 5): w5-admin computes the soonest open deadline.
    nextDueAt: null,
  };
};

const count = sql<number>`count(*)::int`;
/** Items whose deadline has passed, and those due within the hour (only where a queue has one). */
// Raw `sql` parameters are not mapped by a column, so times go in as ISO text with a cast.
const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const overdueBy = (deadline: PgColumn, now: Date) => sql<number>`count(*) filter (where ${deadline} < ${at(now)})::int`;
const dueSoonBy = (deadline: PgColumn, now: Date) =>
  sql<number>`count(*) filter (where ${deadline} >= ${at(now)} and ${deadline} < ${at(new Date(now.getTime() + DUE_SOON_MS))})::int`;
const minOf = (col: PgColumn) => sql<Date | string | null>`min(${col})`;
const none = sql<number>`0`;

async function aggregate(db: Executor, queue: AdminQueue, now: Date): Promise<Agg | undefined> {
  switch (queue) {
    case "moderation":
    case "legal": {
      const where: SQL[] =
        queue === "moderation"
          ? [inArray(moderationCases.tier, ["t1", "t2"]), eq(moderationCases.status, "open")]
          : [eq(moderationCases.tier, "t0"), inArray(moderationCases.status, ["open", "dismissal_pending"])];
      const [row] = await db
        .select({
          open: count,
          overdue: overdueBy(moderationCases.slaDueAt, now),
          dueSoon: dueSoonBy(moderationCases.slaDueAt, now),
          oldestAt: minOf(moderationCases.createdAt),
          unassigned: sql<number>`count(*) filter (where ${moderationCases.assigneeId} is null)::int`,
        })
        .from(moderationCases)
        .where(and(...where));
      return row;
    }
    case "appeals": {
      const [row] = await db
        .select({ open: count, overdue: none, dueSoon: none, oldestAt: minOf(appeals.createdAt) })
        .from(appeals)
        .where(eq(appeals.status, "open"));
      return row;
    }
    case "dmca": {
      // Notices awaiting a decision, plus counter-notices inside their restore window (the
      // window's end is the deadline: content goes back up then unless suit is filed).
      const [[notices], [counters]] = await Promise.all([
        db
          .select({ open: count, oldestAt: minOf(dmcaNotices.createdAt) })
          .from(dmcaNotices)
          .where(eq(dmcaNotices.status, "received")),
        db
          .select({
            open: count,
            overdue: overdueBy(dmcaCounterNotices.restoreAfter, now),
            dueSoon: dueSoonBy(dmcaCounterNotices.restoreAfter, now),
            oldestAt: minOf(dmcaCounterNotices.createdAt),
          })
          .from(dmcaCounterNotices)
          .where(and(isNull(dmcaCounterNotices.restoredAt), isNull(dmcaCounterNotices.suitFiledAt))),
      ]);
      const oldest = [notices?.oldestAt, counters?.oldestAt]
        .filter((d): d is Date | string => d !== null && d !== undefined)
        .map((d) => new Date(d))
        .sort((a, b) => a.getTime() - b.getTime())[0];
      return {
        open: Number(notices?.open ?? 0) + Number(counters?.open ?? 0),
        overdue: Number(counters?.overdue ?? 0),
        dueSoon: Number(counters?.dueSoon ?? 0),
        oldestAt: oldest ?? null,
      };
    }
    case "ncii": {
      const [row] = await db
        .select({
          open: count,
          overdue: overdueBy(nciiRequests.deadlineAt, now),
          dueSoon: dueSoonBy(nciiRequests.deadlineAt, now),
          oldestAt: minOf(nciiRequests.receivedAt),
        })
        .from(nciiRequests)
        .where(isNull(nciiRequests.decidedAt));
      return row;
    }
    case "integrity": {
      const [row] = await db
        .select({ open: count, overdue: none, dueSoon: none, oldestAt: minOf(integrityFlags.createdAt) })
        .from(integrityFlags)
        .where(eq(integrityFlags.decision, "pending_review"));
      return row;
    }
    case "incidents": {
      const [row] = await db
        .select({ open: count, overdue: none, dueSoon: none, oldestAt: minOf(incidents.startedAt) })
        .from(incidents)
        .where(ne(incidents.status, "resolved"));
      return row;
    }
    case "apps_review": {
      const [row] = await db
        .select({ open: count, overdue: none, dueSoon: none, oldestAt: minOf(oauthApps.createdAt) })
        .from(oauthApps)
        .where(
          and(isNull(oauthApps.suspendedAt), gt(oauthApps.createdAt, new Date(now.getTime() - NEW_APP_WINDOW_MS))),
        );
      return row;
    }
    case "payments": {
      // Manual-adapter payments waiting for the treasurer; one not confirmed by `expires_at` fails.
      const [row] = await db
        .select({
          open: count,
          overdue: overdueBy(payments.expiresAt, now),
          dueSoon: dueSoonBy(payments.expiresAt, now),
          oldestAt: minOf(payments.createdAt),
        })
        .from(payments)
        .where(and(eq(payments.status, "pending"), eq(payments.provider, "manual")));
      return row;
    }
  }
}

export async function adminOverview(db: Executor, role: PlatformRole, now: Date): Promise<AdminOverview> {
  const queues = queuesFor(role);
  const aggs = await Promise.all(queues.map((q) => aggregate(db, q, now)));
  return { queues: queues.map((q, i) => toCount(q, aggs[i])) };
}
