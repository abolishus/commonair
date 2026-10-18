// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Membership eligibility (`membership.classes`) and the job that keeps streamer and
 * viewer memberships in line with it. Workers are appointed by the board and are
 * never activated or lapsed here.
 */
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, uuidv7, type Database } from "@commonair/db";
import { eligibleHoursByUser } from "./inputs.ts";
import { contributionWeightsOf, loadSettings, membershipClassesOf, type MembershipClasses } from "./settings.ts";

/** Eligible streaming hours over `membership.classes.streamer.windowDays` meet the minimum. */
export function streamerEligible(hours: number, rules: Pick<MembershipClasses, "streamer">): boolean {
  return Number.isFinite(hours) && hours >= rules.streamer.minStreamingHours;
}

/** A held member share of at least `shareCents`, or an active subscription when that qualifies. */
export function viewerEligible(
  share: { status: "pending" | "held" | "refunded"; amountCents: number } | null,
  activeSubscription: boolean,
  rules: Pick<MembershipClasses, "viewer">,
): boolean {
  if (share && share.status === "held" && share.amountCents >= rules.viewer.shareCents) return true;
  return activeSubscription && rules.viewer.activeSubscriptionQualifies;
}

export interface MembershipChange {
  membershipId: string;
  userId: string;
  class: "streamer" | "viewer";
  basis: "streaming_hours" | "share" | "subscription";
}

export interface SyncResult {
  activated: MembershipChange[];
  lapsed: MembershipChange[];
  /** Active memberships re-confirmed (lastEligibilityCheckAt updated). */
  confirmed: number;
}

type Managed = MembershipChange["class"];
/** Bases this job manages; a streamer membership granted any other way is left alone. */
const MANAGED_BASES: Record<Managed, readonly MembershipChange["basis"][]> = {
  streamer: ["streaming_hours"],
  viewer: ["share", "subscription"],
};

/**
 * Activate newly eligible streamer/viewer members and lapse members who no longer
 * qualify, writing an audit_log row per change. Members whose latest membership in a
 * class is `exited` left voluntarily and are not re-enrolled automatically; banned or
 * deleted users are never activated. Safe to run concurrently (advisory lock) and
 * repeatedly (a second run with the same facts changes nothing).
 */
export async function syncMemberships(db: Database, now: Date): Promise<SyncResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('commonair:membership-sync'))`);
    const settings = await loadSettings(tx);
    const rules = membershipClassesOf(settings);
    const cap = contributionWeightsOf(settings).dailyStreamingHourCap;
    const m = schema.memberships;

    const windowStart = new Date(now.getTime() - rules.streamer.windowDays * 86_400_000);
    const hours = await eligibleHoursByUser(tx, windowStart, now, cap);
    const shares = await tx
      .select({
        userId: schema.membershipShares.userId,
        status: schema.membershipShares.status,
        amountCents: schema.membershipShares.amountCents,
      })
      .from(schema.membershipShares)
      .where(eq(schema.membershipShares.status, "held"));
    const shareOf = new Map<string, (typeof shares)[number]>();
    for (const s of shares) {
      const prev = shareOf.get(s.userId);
      if (!prev || s.amountCents > prev.amountCents) shareOf.set(s.userId, s);
    }
    const subs = await tx
      .selectDistinct({ userId: schema.subscriptions.subscriberId })
      .from(schema.subscriptions)
      .where(
        and(
          eq(schema.subscriptions.status, "active"),
          or(isNull(schema.subscriptions.currentPeriodEnd), gt(schema.subscriptions.currentPeriodEnd, now)),
        ),
      );
    const subscribed = new Set(subs.map((s) => s.userId));

    const rows = await tx
      .select({ id: m.id, userId: m.userId, class: m.class, status: m.status, basis: m.basis, createdAt: m.createdAt })
      .from(m)
      .where(inArray(m.class, ["streamer", "viewer"]))
      .orderBy(m.createdAt, m.id);
    const active = new Map<string, (typeof rows)[number]>();
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = `${r.class}:${r.userId}`;
      latest.set(k, r);
      if (r.status === "active") active.set(k, r);
    }

    const candidates = new Set<string>([...hours.keys(), ...shareOf.keys(), ...subscribed]);
    for (const r of active.values()) candidates.add(r.userId);
    const users = candidates.size
      ? await tx
          .select({ id: schema.users.id, banned: schema.users.banned, deletedAt: schema.users.deletedAt })
          .from(schema.users)
          .where(inArray(schema.users.id, [...candidates]))
      : [];
    const blocked = new Set(users.filter((u) => u.banned || u.deletedAt !== null).map((u) => u.id));

    const result: SyncResult = { activated: [], lapsed: [], confirmed: 0 };
    const confirmIds: string[] = [];
    const lapseIds: string[] = [];
    const inserts: (typeof schema.memberships.$inferInsert)[] = [];

    const decide = (userId: string, cls: Managed, eligible: boolean, basis: MembershipChange["basis"]) => {
      const k = `${cls}:${userId}`;
      const current = active.get(k);
      if (current) {
        if (!MANAGED_BASES[cls].includes(current.basis as MembershipChange["basis"])) return;
        if (eligible) {
          confirmIds.push(current.id);
        } else {
          lapseIds.push(current.id);
          result.lapsed.push({
            membershipId: current.id,
            userId,
            class: cls,
            basis: current.basis as MembershipChange["basis"],
          });
        }
        return;
      }
      if (!eligible || blocked.has(userId) || latest.get(k)?.status === "exited") return;
      const id = uuidv7();
      inserts.push({ id, userId, class: cls, status: "active", basis, joinedAt: now, lastEligibilityCheckAt: now });
      result.activated.push({ membershipId: id, userId, class: cls, basis });
    };

    for (const userId of candidates) {
      decide(userId, "streamer", streamerEligible(hours.get(userId) ?? 0, rules), "streaming_hours");
      const share = shareOf.get(userId) ?? null;
      const shareQualifies = viewerEligible(share, false, rules);
      decide(
        userId,
        "viewer",
        viewerEligible(share, subscribed.has(userId), rules),
        shareQualifies ? "share" : "subscription",
      );
    }

    if (confirmIds.length) {
      await tx.update(m).set({ lastEligibilityCheckAt: now }).where(inArray(m.id, confirmIds));
    }
    if (lapseIds.length) {
      await tx
        .update(m)
        .set({ status: "lapsed", lapsedAt: now, lastEligibilityCheckAt: now })
        .where(and(inArray(m.id, lapseIds), eq(m.status, "active")));
    }
    if (inserts.length) await tx.insert(m).values(inserts);
    result.confirmed = confirmIds.length;

    const audits = [
      ...result.activated.map((c) => ({ c, action: "membership.activate", reason: "eligibility rules met" })),
      ...result.lapsed.map((c) => ({ c, action: "membership.lapse", reason: "eligibility rules no longer met" })),
    ].map(({ c, action, reason }) => ({
      actorType: "system" as const,
      action,
      subjectType: "membership",
      subjectId: c.membershipId,
      reason,
      // Ids and numbers only: audit details are append-only (ADR 0004).
      details: {
        userId: c.userId,
        class: c.class,
        basis: c.basis,
        ...(c.class === "streamer" ? { eligibleHours: hours.get(c.userId) ?? 0 } : {}),
        rules: rules[c.class],
      },
    }));
    if (audits.length) await tx.insert(schema.auditLog).values(audits);
    return result;
  });
}
