// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The go-live email digest (ADR 0028 decision 3): a sweep over `notification_email_queue`, which
 * N1-fanout fills for verified, opted-in followers who passed the cooldown. A member's rows wait
 * `emailDigestMinutes` from the oldest one, then go as one email. One transaction per member, with
 * that member's rows locked (`for update skip locked`), so concurrent sweeps on several replicas
 * never send the same digest twice. The mail is sent inside the transaction and the rows deleted
 * after a successful send: a commit failure after a send can repeat one digest, never lose one.
 */
import { NOTIFICATION_SETTINGS_PATH, EMAIL_UNSUBSCRIBE_PATH, NOTIFY_DEFAULTS } from "@commonair/contracts/notify";
import { schema, type Database } from "@commonair/db";
import type { GoLiveDigestChannel } from "@commonair/email";
import { signUnsubscribeToken } from "@commonair/tokens";
import { and, asc, eq, inArray, lt, min, notInArray, sql } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import { goLiveSetting } from "../settings.ts";

/** Members handled per sweep; the rest wait for the next one (30 s later). */
export const DIGEST_MEMBERS_PER_SWEEP = 200;
/** Rows older than the digest window plus this are dropped: a stale go-live is useless, and a mailbox that keeps failing must not grow the queue. */
export const DIGEST_STALE_AFTER_MS = 3_600_000;

export interface DigestSweepResult {
  /** Members whose rows this sweep locked and handled. */
  users: number;
  /** Emails sent. */
  sent: number;
}

const q = schema.notificationEmailQueue;
const np = schema.notificationPreferences;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface QueuedRow {
  eventId: string;
  channelId: string;
  queuedAt: Date;
}

/** Whether the member still wants go-live email from `channelId`: the override, else their default, else the built-in. */
export function emailEnabledFor(
  rows: readonly { channelId: string | null; enabled: boolean }[],
  channelId: string,
): boolean {
  const override = rows.find((r) => r.channelId === channelId);
  if (override) return override.enabled;
  const fallback = rows.find((r) => r.channelId === null);
  return fallback ? fallback.enabled : NOTIFY_DEFAULTS.go_live.email;
}

/** After a failed send a member is skipped for this long, so failing mailboxes cannot fill every sweep. */
export const DIGEST_FAILURE_BACKOFF_MS = 300_000;

/**
 * Members whose last send failed, with the time they may be tried again. Per process: another
 * replica may still try them, which is harmless. Bounded by the members with queued rows.
 */
const failedUntil = new Map<string, number>();

/** For tests: forget every member's failure backoff. */
export function resetDigestBackoff(): void {
  failedUntil.clear();
}

/** One sweep: drop stale rows (even with no mailer, so the queue never grows unbounded), then send each due member's digest. */
export async function sweepEmailDigests(ctx: WorkerContext): Promise<DigestSweepResult> {
  const { emailDigestMinutes } = await goLiveSetting(ctx.db, ctx.logger);
  const windowMs = emailDigestMinutes * 60_000;
  const nowMs = ctx.now().getTime();
  const dueBefore = new Date(nowMs - windowMs);

  const stale = await ctx.db
    .delete(q)
    .where(lt(q.queuedAt, new Date(nowMs - windowMs - DIGEST_STALE_AFTER_MS)))
    .returning({ userId: q.userId });
  if (stale.length > 0)
    ctx.logger.warn("go-live email rows dropped as stale", {
      rows: stale.length,
      users: new Set(stale.map((r) => r.userId)).size,
    });

  const { mailer, site } = ctx;
  if (!mailer || !site) return { users: 0, sent: 0 };
  for (const [userId, until] of failedUntil) if (until <= nowMs) failedUntil.delete(userId);
  const backingOff = [...failedUntil.keys()];

  const due = await ctx.db
    .select({ userId: q.userId })
    .from(q)
    .where(backingOff.length > 0 ? notInArray(q.userId, backingOff) : undefined)
    .groupBy(q.userId)
    .having(sql`${min(q.queuedAt)} <= ${dueBefore.toISOString()}::timestamptz`)
    .orderBy(asc(min(q.queuedAt)))
    .limit(DIGEST_MEMBERS_PER_SWEEP);

  const result: DigestSweepResult = { users: 0, sent: 0 };
  for (const { userId } of due) {
    const outcome = await ctx.db.transaction((tx) => digestFor(ctx, tx, userId, dueBefore));
    if (outcome === "locked") continue;
    if (outcome === "failed") failedUntil.set(userId, nowMs + DIGEST_FAILURE_BACKOFF_MS);
    else failedUntil.delete(userId);
    result.users++;
    if (outcome === "sent") result.sent++;
  }
  return result;
}

type Outcome = "locked" | "sent" | "none" | "failed";

async function digestFor(ctx: WorkerContext, tx: Tx, userId: string, dueBefore: Date): Promise<Outcome> {
  const { mailer, site } = ctx;
  if (!mailer || !site) return "locked";
  const locked: QueuedRow[] = await tx
    .select({ eventId: q.eventId, channelId: q.channelId, queuedAt: q.queuedAt })
    .from(q)
    .where(eq(q.userId, userId))
    .orderBy(asc(q.queuedAt))
    .for("update", { skipLocked: true });
  // Another sweep holds them, or sent them since we looked; or only rows queued after its lock
  // are left, which are not due yet.
  const oldest = locked[0];
  if (!oldest || oldest.queuedAt > dueBefore) return "locked";
  const all = locked.map((r) => r.eventId);
  const remove = (eventIds: string[]) =>
    eventIds.length === 0
      ? Promise.resolve()
      : tx.delete(q).where(and(eq(q.userId, userId), inArray(q.eventId, eventIds)));

  const [user] = await tx
    .select({
      email: schema.users.email,
      emailVerified: schema.users.emailVerified,
      locale: schema.users.locale,
      matureConfirmedAt: schema.users.matureConfirmedAt,
      deletedAt: schema.users.deletedAt,
      pseudonymizedAt: schema.users.pseudonymizedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user || !user.emailVerified || user.deletedAt !== null || user.pseudonymizedAt !== null) {
    await remove(all);
    ctx.logger.info("go-live email dropped: no verified address", { userId, rows: all.length });
    return "none";
  }

  const details = await tx
    .select({
      eventId: q.eventId,
      channelId: q.channelId,
      slug: schema.channels.slug,
      name: schema.channels.displayName,
      channelMature: schema.channels.mature,
      title: schema.broadcasts.title,
      broadcastMature: schema.broadcasts.mature,
      notify: schema.follows.notify,
      excludedAt: schema.follows.excludedAt,
    })
    .from(q)
    .innerJoin(schema.channels, eq(schema.channels.id, q.channelId))
    .innerJoin(schema.broadcasts, eq(schema.broadcasts.id, q.broadcastId))
    .leftJoin(schema.follows, and(eq(schema.follows.followerId, q.userId), eq(schema.follows.channelId, q.channelId)))
    .where(and(eq(q.userId, userId), inArray(q.eventId, all)))
    .orderBy(asc(q.queuedAt));
  const prefs = await tx
    .select({ channelId: np.channelId, enabled: np.enabled })
    .from(np)
    .where(and(eq(np.userId, userId), eq(np.type, "go_live"), eq(np.medium, "email")));

  const base = site.publicUrl.replace(/\/+$/, "");
  const matureHidden = user.matureConfirmedAt === null;
  const channels: GoLiveDigestChannel[] = [];
  const seen = new Set<string>();
  for (const d of details) {
    // Opted out since queuing: unfollowed, bell off, the follow excluded, or email turned off.
    if (d.notify !== true || d.excludedAt !== null || !emailEnabledFor(prefs, d.channelId)) continue;
    if (seen.has(d.channelId)) continue;
    seen.add(d.channelId);
    const mature = d.broadcastMature || d.channelMature;
    channels.push({
      name: d.name,
      title: mature && matureHidden ? "" : d.title,
      url: `${base}/${encodeURIComponent(d.slug)}`,
    });
  }
  if (channels.length === 0) {
    await remove(all);
    ctx.logger.info("go-live email dropped: opted out since queued", { userId, rows: all.length });
    return "none";
  }

  // The worker's AUTH_SECRET reaches the context as the webhook settings' secret (main.ts); the API
  // verifies with its own AUTH_SECRET, so the two must stay the same value.
  const token = await signUnsubscribeToken(ctx.webhooks.authSecret, userId, "go_live");
  try {
    await mailer.send(
      "goLiveDigest",
      {
        channels,
        settingsUrl: `${base}${NOTIFICATION_SETTINGS_PATH}`,
        unsubscribeUrl: `${base}${EMAIL_UNSUBSCRIBE_PATH}?list=go_live&token=${encodeURIComponent(token)}`,
        locale: user.locale,
      },
      user.email,
    );
  } catch (err) {
    // The rows stay for the next sweep (until they go stale); never log the address.
    ctx.logger.warn("go-live email send failed", {
      userId,
      channels: channels.length,
      error: err instanceof Error ? err.name : "unknown",
    });
    return "failed";
  }
  await remove(all);
  ctx.logger.info("go-live email sent", { userId, channels: channels.length, rows: all.length });
  return "sent";
}
