// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The weekly "What you missed" email (overhaul wave 4, D7.3; account-admin.md P5). Opt-in only:
 * members whose own `digest_weekly` email default is on (no row means off, `NOTIFY_DEFAULTS`)
 * and whose address is verified. Sent on `DIGEST_RULES.weekdayUtc` from `sendHourUtc` (UTC: members
 * have no stored time zone); the hourly job does nothing on other days.
 *
 * Once per member and week, across retries and replicas: each member's send runs in one
 * transaction that first inserts their `notification_digest_sends` row (primary key user and week).
 * A replica that loses the race waits on that key and then inserts nothing, so it skips; a failed
 * send rolls the claim back so the next hourly run tries again. A member with nothing new this
 * week keeps the claim and gets no email (skipped when empty).
 *
 * Content: up to `DIGEST_RULES.maxItems` public videos and clips from channels they follow made in
 * the last 7 days (mature ones only after an 18+ confirmation), and the open co-op votes they are
 * in the electorate of. Text and links only (no images, so no tracking pixel). Every link carries
 * `?src=digest`, which the web counts in aggregate and strips.
 */
import { DIGEST_RULES, EMAIL_LINK_SOURCES } from "@commonair/contracts/enums";
import { NOTIFICATION_SETTINGS_PATH } from "@commonair/contracts/notify";
import { schema, type Database } from "@commonair/db";
import type { WeeklyDigestItem, WeeklyDigestVote } from "@commonair/email";
import { and, asc, desc, eq, gte, isNull, lt, notExists, notInArray, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import { unsubscribeUrl } from "../email/prefs.ts";

const DAY_MS = 86_400_000;
/** Members per batch; a run loops until no eligible member is left. */
export const WEEKLY_DIGEST_BATCH = 200;
/** The `src` every digest link carries. */
export const DIGEST_SOURCE: (typeof EMAIL_LINK_SOURCES)[number] = "digest";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The UTC date (`YYYY-MM-DD`) of the Monday that starts `now`'s ISO week: the claim's week. */
export function weekStartOf(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - day * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

/** Whether `now` is in the send window: the digest weekday, from the send hour to midnight UTC. */
export function digestDue(now: Date): boolean {
  return now.getUTCDay() === DIGEST_RULES.weekdayUtc && now.getUTCHours() >= DIGEST_RULES.sendHourUtc;
}

/** `path` on the instance with `?src=digest` (kept with any query it has). */
export function digestLink(publicUrl: string, path: string): string {
  const url = new URL(path, `${publicUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("src", DIGEST_SOURCE);
  return url.toString();
}

export interface WeeklyDigestResult {
  due: boolean;
  /** Members claimed this run (sent or skipped as empty). */
  claimed: number;
  sent: number;
  /** Claimed with nothing to tell. */
  empty: number;
  failed: number;
}

const np = schema.notificationPreferences;
const sends = schema.notificationDigestSends;
const u = schema.users;

/** One run: when due, every eligible member not yet claimed this week, in batches. */
export async function runWeeklyDigest(ctx: WorkerContext): Promise<WeeklyDigestResult> {
  const now = ctx.now();
  const result: WeeklyDigestResult = { due: digestDue(now), claimed: 0, sent: 0, empty: 0, failed: 0 };
  if (!result.due || !ctx.mailer || !ctx.site) return result;
  const week = weekStartOf(now);
  // Members whose send failed this run are left for the next run (an hour later).
  const failed = new Set<string>();
  for (;;) {
    const batch = await eligible(ctx.db, week, [...failed]);
    if (batch.length === 0) break;
    for (const userId of batch) {
      try {
        const outcome = await ctx.db.transaction((tx) => digestFor(ctx, tx, userId, week, now));
        if (outcome === "taken") continue;
        result.claimed++;
        if (outcome === "sent") result.sent++;
        else result.empty++;
      } catch (err) {
        // The claim rolled back with the transaction; never log the address.
        failed.add(userId);
        result.failed++;
        ctx.logger.warn("weekly digest send failed", {
          userId,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }
    if (batch.length < WEEKLY_DIGEST_BATCH) break;
  }
  if (result.claimed > 0 || result.failed > 0) ctx.logger.info("weekly digest run", { week, ...result });
  return result;
}

/** Opted-in, verified, live human members without a claim for `week`. */
async function eligible(db: Database, week: string, skip: readonly string[]): Promise<string[]> {
  const rows = await db
    .select({ id: u.id })
    .from(u)
    .innerJoin(
      np,
      and(
        eq(np.userId, u.id),
        eq(np.type, "digest_weekly"),
        eq(np.medium, "email"),
        isNull(np.channelId),
        eq(np.enabled, true),
      ),
    )
    .where(
      and(
        eq(u.accountType, "human"),
        eq(u.emailVerified, true),
        isNull(u.deletedAt),
        isNull(u.pseudonymizedAt),
        skip.length > 0 ? notInArray(u.id, [...skip]) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(sends)
            .where(and(eq(sends.userId, u.id), eq(sends.weekStart, week))),
        ),
      ),
    )
    .orderBy(asc(u.id))
    .limit(WEEKLY_DIGEST_BATCH);
  return rows.map((r) => r.id);
}

type Outcome = "taken" | "sent" | "empty";

async function digestFor(ctx: WorkerContext, tx: Tx, userId: string, week: string, now: Date): Promise<Outcome> {
  const { mailer, site } = ctx;
  if (!mailer || !site) return "taken";
  const claimed = await tx
    .insert(sends)
    .values({ userId, weekStart: week, createdAt: now })
    .onConflictDoNothing()
    .returning({ userId: sends.userId });
  if (claimed.length === 0) return "taken";

  const [user] = await tx
    .select({ email: u.email, locale: u.locale, matureConfirmedAt: u.matureConfirmedAt })
    .from(u)
    .where(eq(u.id, userId));
  if (!user) return "empty";
  const content = await digestContent(tx, userId, now, user.matureConfirmedAt !== null, site.publicUrl);
  if (content.items.length === 0 && content.votes.length === 0) return "empty";

  await mailer.send(
    "weeklyDigest",
    {
      ...content,
      settingsUrl: digestLink(site.publicUrl, NOTIFICATION_SETTINGS_PATH),
      unsubscribeUrl: await unsubscribeUrl(site.publicUrl, ctx.webhooks.authSecret, userId, "weekly"),
      locale: user.locale,
    },
    user.email,
  );
  return "sent";
}

/** What one member's digest lists (exported for tests). */
export async function digestContent(
  db: Database | Tx,
  userId: string,
  now: Date,
  matureOk: boolean,
  publicUrl: string,
): Promise<{ items: WeeklyDigestItem[]; votes: WeeklyDigestVote[] }> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const { vods, clips, channels, broadcasts, follows, proposals, proposalElectorate } = schema;
  const followed = and(eq(follows.followerId, userId), isNull(follows.excludedAt));

  const videos = await db
    .select({
      id: vods.id,
      title: vods.title,
      createdAt: vods.createdAt,
      slug: channels.slug,
      name: channels.displayName,
    })
    .from(vods)
    .innerJoin(channels, eq(channels.id, vods.channelId))
    .innerJoin(broadcasts, eq(broadcasts.id, vods.broadcastId))
    .innerJoin(follows, and(eq(follows.channelId, vods.channelId), followed))
    .where(
      and(
        eq(vods.status, "ready"),
        eq(vods.visibility, "public"),
        eq(broadcasts.kind, "live"),
        isNull(channels.suspendedAt),
        gte(vods.createdAt, since),
        lt(vods.createdAt, now),
        matureOk ? undefined : and(eq(channels.mature, false), eq(broadcasts.mature, false)),
      ),
    )
    .orderBy(desc(vods.createdAt))
    .limit(DIGEST_RULES.maxItems);

  const clipRows = await db
    .select({
      id: clips.id,
      title: clips.title,
      createdAt: clips.createdAt,
      slug: channels.slug,
      name: channels.displayName,
    })
    .from(clips)
    .innerJoin(channels, eq(channels.id, clips.channelId))
    .innerJoin(follows, and(eq(follows.channelId, clips.channelId), followed))
    .leftJoin(broadcasts, eq(broadcasts.id, clips.broadcastId))
    .where(
      and(
        eq(clips.status, "ready"),
        isNull(clips.removedReason),
        isNull(channels.suspendedAt),
        gte(clips.createdAt, since),
        lt(clips.createdAt, now),
        matureOk
          ? undefined
          : and(eq(channels.mature, false), or(isNull(broadcasts.mature), eq(broadcasts.mature, false))),
      ),
    )
    .orderBy(desc(clips.createdAt))
    .limit(DIGEST_RULES.maxItems);

  const items = [
    ...videos.map((v) => ({ ...v, kind: "video" as const, path: `/${v.slug}/vods/${v.id}` })),
    ...clipRows.map((c) => ({ ...c, kind: "clip" as const, path: `/${c.slug}/clips/${c.id}` })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, DIGEST_RULES.maxItems)
    .map((r) => ({
      kind: r.kind,
      channelName: r.name,
      title: r.title,
      url: digestLink(publicUrl, encodeURI(r.path)),
    }));

  const open = await db
    .select({ id: proposals.id, title: proposals.title, votingEndsAt: proposals.votingEndsAt })
    .from(proposals)
    .innerJoin(
      proposalElectorate,
      and(eq(proposalElectorate.proposalId, proposals.id), eq(proposalElectorate.userId, userId)),
    )
    .where(and(eq(proposals.status, "voting"), sql`${proposals.votingEndsAt} > ${now.toISOString()}::timestamptz`))
    .orderBy(asc(proposals.votingEndsAt));
  const votes = open.flatMap((p) =>
    p.votingEndsAt
      ? [{ title: p.title, closesAt: p.votingEndsAt, url: digestLink(publicUrl, `/coop/proposals/${p.id}`) }]
      : [],
  );
  return { items, votes };
}
