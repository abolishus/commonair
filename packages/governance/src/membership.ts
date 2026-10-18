// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Membership eligibility (`membership.classes`) and the job that keeps streamer and
 * viewer memberships in line with it. Workers are appointed by the board and are
 * never activated or lapsed here.
 */
import { sql } from "drizzle-orm";
import { schema, uuidv7, type Database, type Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { eligibleHoursByUser, tsz } from "./inputs.ts";
import { contributionWeightsOf, loadSettings, membershipClassesOf, type MembershipClasses } from "./settings.ts";

/** Eligible streaming hours over `membership.classes.streamer.windowDays` meet the minimum. */
export function streamerEligible(hours: number, rules: Pick<MembershipClasses, "streamer">): boolean {
  return Number.isFinite(hours) && hours >= rules.streamer.minStreamingHours;
}

/** A held member share of at least `shareCents`, or a qualifying subscription when subscriptions qualify. */
export function viewerEligible(
  share: { status: "pending" | "held" | "refunded"; amountCents: number } | null,
  qualifyingSubscription: boolean,
  rules: Pick<MembershipClasses, "viewer">,
): boolean {
  if (share && share.status === "held" && share.amountCents >= rules.viewer.shareCents) return true;
  return qualifyingSubscription && rules.viewer.activeSubscriptionQualifies;
}

export interface SubscriptionFacts {
  status: string;
  priceCents: number;
  provider: string;
  currentPeriodEnd: Date | null;
  giftedById: string | null;
  /** True when the subscriber owns the channel subscribed to. */
  ownChannel: boolean;
}

/**
 * Whether a subscription can qualify its holder for viewer membership: active, paid by
 * the holder (not gifted), to someone else's channel, at or above `minSubscriptionCents`,
 * with a known paid-through date (manual-provider subscriptions may omit it).
 */
export function subscriptionQualifies(
  s: SubscriptionFacts,
  now: Date,
  rules: Pick<MembershipClasses, "viewer">,
): boolean {
  if (s.status !== "active" || s.giftedById !== null || s.ownChannel) return false;
  if (s.priceCents < rules.viewer.minSubscriptionCents) return false;
  if (s.currentPeriodEnd === null) return s.provider === "manual";
  return s.currentPeriodEnd.getTime() > now.getTime();
}

export interface MembershipChange {
  membershipId: string;
  userId: string;
  class: "streamer" | "viewer";
  basis: "streaming_hours" | "share" | "subscription";
}

export interface LapseRefusal {
  class: "streamer" | "viewer";
  wouldLapse: number;
  active: number;
  limit: number;
}

export interface SyncResult {
  activated: MembershipChange[];
  lapsed: MembershipChange[];
  /** Active memberships re-confirmed (lastEligibilityCheckAt updated). */
  confirmed: number;
  /** Classes whose lapses were withheld by the mass-lapse guard. */
  refused: LapseRefusal[];
}

export interface SyncOptions {
  /** Lapse even when more than the guard allows (an operator's explicit decision). */
  allowMassLapse?: boolean;
  /** Fraction of a class's active managed memberships one run may lapse (default 0.1). */
  maxLapseFraction?: number;
  /** Lapses always allowed per class per run regardless of the fraction (default 3). */
  minLapseAllowance?: number;
  logger?: Pick<Logger, "warn">;
}

type Managed = MembershipChange["class"];
type Basis = MembershipChange["basis"];
/** Bases this job manages; a membership granted any other way is left alone. */
const MANAGED_BASES: Record<Managed, readonly Basis[]> = {
  streamer: ["streaming_hours"],
  viewer: ["share", "subscription"],
};

type Row = Record<string, unknown>;
const rows = (r: unknown) => r as Row[];
/** A uuid[] parameter (ids are validated uuids from the database). */
const uuids = (ids: Iterable<string>) => sql`${`{${[...ids].join(",")}}`}::uuid[]`;
const json = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

/** Users holding a subscription that qualifies for viewer membership. */
async function qualifyingSubscribers(tx: Executor, now: Date, rules: MembershipClasses): Promise<Set<string>> {
  const r = rows(
    await tx.execute(sql`
      select distinct s.subscriber_id
        from subscriptions s join channels c on c.id = s.channel_id
       where s.status = 'active' and s.gifted_by_id is null and c.owner_id <> s.subscriber_id
         and s.price_cents >= ${rules.viewer.minSubscriptionCents}
         and (s.current_period_end > ${tsz(now)} or (s.current_period_end is null and s.provider = 'manual'))`),
  );
  return new Set(r.map((x) => String(x.subscriber_id)));
}

/**
 * Activate newly eligible streamer/viewer members and lapse members who no longer
 * qualify, writing an audit_log row per change.
 *
 * - Streamers are lapsed only when they also miss the minimum over the window extended by
 *   `lapseGraceDays`, so a short break does not cost a membership.
 * - A run never lapses more than `max(minLapseAllowance, maxLapseFraction × active)` members
 *   of a class unless `allowMassLapse` is set: a mass lapse is far more likely to be a data
 *   problem (lost stream hours, a payment outage) than reality. Refusals are logged and audited.
 * - Banned or deleted users are never activated; members who exited and qualify again are
 *   re-activated with a new membership row.
 * - Safe to run concurrently (advisory lock, and inserts tolerate a concurrent activation)
 *   and repeatedly (a second run with the same facts changes nothing).
 */
export async function syncMemberships(db: Database, now: Date, opts: SyncOptions = {}): Promise<SyncResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('commonair:membership-sync'))`);
    const settings = await loadSettings(tx);
    const rules = membershipClassesOf(settings);
    const cap = contributionWeightsOf(settings).dailyStreamingHourCap;

    const day = 86_400_000;
    const hours = await eligibleHoursByUser(tx, new Date(now.getTime() - rules.streamer.windowDays * day), now, cap);
    const graceHours = await eligibleHoursByUser(
      tx,
      new Date(now.getTime() - (rules.streamer.windowDays + rules.streamer.lapseGraceDays) * day),
      now,
      cap,
    );
    const shareOf = new Map(
      rows(
        await tx.execute(sql`
          select user_id, max(amount_cents) as cents from membership_shares where status = 'held' group by user_id`),
      ).map((r) => [String(r.user_id), { status: "held" as const, amountCents: Number(r.cents) }]),
    );
    const subscribed = await qualifyingSubscribers(tx, now, rules);

    // One row per (user, class): the active membership if any, else the latest.
    const current = new Map<string, { id: string; userId: string; status: string; basis: Basis }>();
    for (const r of rows(
      await tx.execute(sql`
        select distinct on (user_id, class) id, user_id, class, status, basis
          from memberships where class in ('streamer', 'viewer')
         order by user_id, class, (status = 'active') desc, created_at desc, id desc`),
    )) {
      current.set(`${String(r.class)}:${String(r.user_id)}`, {
        id: String(r.id),
        userId: String(r.user_id),
        status: String(r.status),
        basis: r.basis as Basis,
      });
    }

    const candidates = new Set<string>([...hours.keys(), ...shareOf.keys(), ...subscribed]);
    for (const c of current.values()) if (c.status === "active") candidates.add(c.userId);
    const blocked = new Set(
      candidates.size
        ? rows(
            await tx.execute(sql`
              select id from users where (banned or deleted_at is not null) and id = any(${uuids(candidates)})`),
          ).map((r) => String(r.id))
        : [],
    );

    const result: SyncResult = { activated: [], lapsed: [], confirmed: 0, refused: [] };
    const confirmIds: string[] = [];
    const lapses: Record<Managed, MembershipChange[]> = { streamer: [], viewer: [] };
    const activeManaged: Record<Managed, number> = { streamer: 0, viewer: 0 };
    const inserts: { id: string; user_id: string; class: Managed; basis: Basis }[] = [];

    const decide = (userId: string, cls: Managed, eligible: boolean, keep: boolean, basis: Basis) => {
      const c = current.get(`${cls}:${userId}`);
      if (c?.status === "active") {
        if (!MANAGED_BASES[cls].includes(c.basis)) return;
        activeManaged[cls]++;
        if (eligible || keep) confirmIds.push(c.id);
        else lapses[cls].push({ membershipId: c.id, userId, class: cls, basis: c.basis });
        return;
      }
      if (!eligible || blocked.has(userId)) return;
      inserts.push({ id: uuidv7(), user_id: userId, class: cls, basis });
    };

    for (const userId of candidates) {
      const streamer = streamerEligible(hours.get(userId) ?? 0, rules);
      decide(userId, "streamer", streamer, streamerEligible(graceHours.get(userId) ?? 0, rules), "streaming_hours");
      const share = shareOf.get(userId) ?? null;
      const viewer = viewerEligible(share, subscribed.has(userId), rules);
      decide(userId, "viewer", viewer, false, viewerEligible(share, false, rules) ? "share" : "subscription");
    }

    const audits: (typeof schema.auditLog.$inferInsert)[] = [];
    const lapseIds: string[] = [];
    for (const cls of ["streamer", "viewer"] as const) {
      const limit = Math.max(
        opts.minLapseAllowance ?? 3,
        Math.floor((opts.maxLapseFraction ?? 0.1) * activeManaged[cls]),
      );
      if (lapses[cls].length > limit && !opts.allowMassLapse) {
        const refusal = { class: cls, wouldLapse: lapses[cls].length, active: activeManaged[cls], limit };
        result.refused.push(refusal);
        opts.logger?.warn("membership sync refused a mass lapse", refusal);
        audits.push({
          actorType: "system",
          action: "membership.lapse_refused",
          subjectType: "membership_class",
          subjectId: cls,
          reason: "mass-lapse guard: more lapses than one run may make",
          details: { ...refusal },
        });
        // Still eligible-or-not, these members stay active until an operator confirms.
        continue;
      }
      result.lapsed.push(...lapses[cls]);
      lapseIds.push(...lapses[cls].map((l) => l.membershipId));
    }

    if (confirmIds.length) {
      await tx.execute(
        sql`update memberships set last_eligibility_check_at = ${tsz(now)} where id = any(${uuids(confirmIds)})`,
      );
    }
    if (lapseIds.length) {
      await tx.execute(sql`
        update memberships set status = 'lapsed', lapsed_at = ${tsz(now)}, last_eligibility_check_at = ${tsz(now)}
         where id = any(${uuids(lapseIds)}) and status = 'active'`);
    }
    if (inserts.length) {
      // A concurrent activation (another writer) wins; ours is skipped, never an error.
      const inserted = rows(
        await tx.execute(sql`
          insert into memberships (id, user_id, class, status, basis, joined_at, last_eligibility_check_at)
          select v.id, v.user_id, v.class::member_class, 'active', v.basis::membership_basis, ${tsz(now)}, ${tsz(now)}
            from jsonb_to_recordset(${json(inserts)}) as v(id uuid, user_id uuid, class text, basis text)
          on conflict (user_id, class) where status = 'active' do nothing
          returning id, user_id, class, basis`),
      );
      result.activated = inserted.map((r) => ({
        membershipId: String(r.id),
        userId: String(r.user_id),
        class: r.class as Managed,
        basis: r.basis as Basis,
      }));
    }
    result.confirmed = confirmIds.length;

    for (const [list, action, reason] of [
      [result.activated, "membership.activate", "eligibility rules met"],
      [result.lapsed, "membership.lapse", "eligibility rules no longer met"],
    ] as const) {
      for (const c of list) {
        audits.push({
          actorType: "system",
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
        });
      }
    }
    if (audits.length) await tx.insert(schema.auditLog).values(audits);
    return result;
  });
}
