// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The go-live fan-out (ADR 0028 decisions 3, 4 and 8): one job is one page of a channel's
 * notifying followers. One query reads the page with each follower's preferences, one upsert
 * applies the cooldown, two inserts write the in-app rows and the email queue, all in one
 * transaction; after commit the push jobs, the Discord job (first page) and the next page are
 * enqueued. Every step is idempotent by event and follower, so a retried job writes nothing twice.
 */
import type { NotifyMedium } from "@commonair/contracts/enums";
import { QUEUES, type GoLiveJob } from "@commonair/contracts/internal";
import { NOTIFY_RULES, type GoLiveNotificationPayload } from "@commonair/contracts/notify";
import { anchoredUser, schema, uuidv7 } from "@commonair/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../../context.ts";
import { goLiveSetting } from "../settings.ts";
import { claimCooldown } from "./cooldown.ts";
import { anyMedium, goLiveTitle, resolveMedia, type FollowerFacts, type Media } from "./media.ts";
import { fanoutMetrics } from "./metrics.ts";
import { discordJob, nextPageJob, pushJobs } from "./plan.ts";

export interface GoLiveResult {
  /** Followers on this page (after the bot, owner and deleted-account filters). */
  followers: number;
  /** In-app rows written (a retry finds them already there and writes none). */
  inApp: number;
  /** Email queue rows written. */
  email: number;
  /** Push jobs enqueued. */
  push: number;
  /** Followers with a medium the cooldown refused. */
  cooledDown: number;
  nextPage: boolean;
}

export const ZERO_RESULT: GoLiveResult = { followers: 0, inApp: 0, email: 0, push: 0, cooledDown: 0, nextPage: false };

export interface GoLiveOptions {
  /** Tests only: followers per page (default `NOTIFY_RULES.fanoutPageSize`). */
  pageSize?: number;
}

/** The part of a `stream.online` payload the fan-out reads (the rest is the broadcaster's names). */
const OnlinePayload = z.object({ id: z.uuid() });

interface GoLive {
  eventId: string;
  channelId: string;
  ownerId: string;
  slug: string;
  channelMature: boolean;
  broadcastId: string;
  title: string;
  broadcastMature: boolean;
}

/** The event, its channel and its broadcast; null (logged) when any is missing or not a go-live. */
async function loadGoLive(ctx: WorkerContext, eventId: string): Promise<GoLive | null> {
  const [event] = await ctx.db
    .select({ type: schema.events.type, channelId: schema.events.channelId, payload: schema.events.payload })
    .from(schema.events)
    .where(eq(schema.events.id, eventId));
  const payload = OnlinePayload.safeParse(event?.payload);
  if (!event || event.type !== "stream.online" || !event.channelId || !payload.success) {
    // Nothing would fix it on retry: log and finish.
    ctx.logger.warn("go-live: no stream.online event to fan out", {
      eventId,
      found: event !== undefined,
      type: event?.type,
    });
    return null;
  }
  const [row] = await ctx.db
    .select({
      channelId: schema.channels.id,
      ownerId: schema.channels.ownerId,
      slug: schema.channels.slug,
      channelMature: schema.channels.mature,
      broadcastId: schema.broadcasts.id,
      title: schema.broadcasts.title,
      broadcastMature: schema.broadcasts.mature,
    })
    .from(schema.broadcasts)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.broadcasts.channelId))
    .where(eq(schema.broadcasts.id, payload.data.id));
  if (!row || row.channelId !== event.channelId) {
    ctx.logger.warn("go-live: the event's broadcast or channel is gone", { eventId, channelId: event.channelId });
    return null;
  }
  return { eventId, ...row };
}

interface PageRow {
  user_id: string;
  excluded: boolean;
  email_verified: boolean;
  mature_confirmed: boolean;
  demo: boolean;
  has_push: boolean;
  in_app_ch: boolean | null;
  in_app_def: boolean | null;
  email_ch: boolean | null;
  email_def: boolean | null;
  push_ch: boolean | null;
  push_def: boolean | null;
}

/**
 * One page of followers with their facts: `follows_channel_notify_idx` in follower order, each
 * follower's go-live preference rows (`notification_prefs_uq`) folded into six tri-states by one
 * lateral aggregate. Users who never get notifications are filtered before the limit.
 */
export function pageQuery(g: Pick<GoLive, "channelId" | "ownerId">, after: string | null, pageSize: number) {
  const pref = (medium: NotifyMedium, scope: "ch" | "def") =>
    sql.raw(
      `bool_or(np.enabled) filter (where np.medium = '${medium}' and np.channel_id is ${scope === "ch" ? "not null" : "null"}) as ${medium}_${scope}`,
    );
  return sql`
    select f.follower_id as user_id,
           f.excluded_at is not null as excluded,
           users.email_verified,
           users.mature_confirmed_at is not null as mature_confirmed,
           ${anchoredUser()} as demo,
           exists (select 1 from push_subscriptions ps where ps.user_id = f.follower_id) as has_push,
           p.in_app_ch, p.in_app_def, p.email_ch, p.email_def, p.push_ch, p.push_def
      from follows f
      join users on users.id = f.follower_id
      left join lateral (
        select ${pref("in_app", "ch")}, ${pref("in_app", "def")},
               ${pref("email", "ch")}, ${pref("email", "def")},
               ${pref("push", "ch")}, ${pref("push", "def")}
          from notification_preferences np
         where np.user_id = f.follower_id
           and np.type = 'go_live'
           and (np.channel_id = ${g.channelId}::uuid or np.channel_id is null)
      ) p on true
     where f.channel_id = ${g.channelId}::uuid
       and f.notify
       ${after === null ? sql`` : sql`and f.follower_id > ${after}::uuid`}
       and users.account_type <> 'bot'
       and users.id <> ${g.ownerId}::uuid
       and users.deleted_at is null
       and users.pseudonymized_at is null
     order by f.follower_id
     limit ${pageSize}`;
}

export function factsOf(r: PageRow): FollowerFacts {
  return {
    prefs: {
      in_app: { channel: r.in_app_ch, fallback: r.in_app_def },
      email: { channel: r.email_ch, fallback: r.email_def },
      push: { channel: r.push_ch, fallback: r.push_def },
    },
    excluded: r.excluded,
    emailVerified: r.email_verified,
    demo: r.demo,
    hasPushSubscription: r.has_push,
  };
}

interface Winner {
  userId: string;
  media: Media;
  matureConfirmed: boolean;
}

/** Fan out one page of `job`. Never throws for a missing event; throws (and is retried) on infrastructure errors. */
export async function fanOutGoLive(
  ctx: WorkerContext,
  job: GoLiveJob,
  opts: GoLiveOptions = {},
): Promise<GoLiveResult> {
  const pageSize = opts.pageSize ?? NOTIFY_RULES.fanoutPageSize;
  const g = await loadGoLive(ctx, job.eventId);
  if (!g) return { ...ZERO_RESULT };
  const setting = await goLiveSetting(ctx.db, ctx.logger);
  const now = ctx.now();
  const pushAvailable = ctx.webPush !== undefined;

  const page = await ctx.db.transaction(async (tx) => {
    const rows = (await tx.execute(pageQuery(g, job.after, pageSize))) as unknown as PageRow[];
    const candidates: Winner[] = [];
    for (const r of rows) {
      const media = resolveMedia(factsOf(r), pushAvailable);
      if (anyMedium(media)) candidates.push({ userId: r.user_id, media, matureConfirmed: r.mature_confirmed });
    }
    const passed = await claimCooldown(tx, {
      channelId: g.channelId,
      eventId: g.eventId,
      now,
      cooldownHours: setting.cooldownHours,
      userIds: candidates.map((c) => c.userId),
    });
    const winners = candidates.filter((c) => passed.has(c.userId));

    const inAppRows = winners
      .filter((w) => w.media.in_app)
      .map((w) => {
        const payload: GoLiveNotificationPayload = {
          channelId: g.channelId,
          slug: g.slug,
          broadcastId: g.broadcastId,
          title: goLiveTitle({
            title: g.title,
            broadcastMature: g.broadcastMature,
            channelMature: g.channelMature,
            matureConfirmed: w.matureConfirmed,
          }),
        };
        return {
          id: uuidv7(now.getTime()),
          userId: w.userId,
          type: "go_live" as const,
          payload,
          dedupeKey: `go-live-${g.eventId}`,
        };
      });
    const inApp =
      inAppRows.length === 0
        ? []
        : await tx
            .insert(schema.notifications)
            .values(inAppRows)
            .onConflictDoNothing()
            .returning({ id: schema.notifications.id });

    const emailRows = winners
      .filter((w) => w.media.email)
      .map((w) => ({ userId: w.userId, eventId: g.eventId, channelId: g.channelId, broadcastId: g.broadcastId }));
    const email =
      emailRows.length === 0
        ? []
        : await tx
            .insert(schema.notificationEmailQueue)
            .values(emailRows)
            .onConflictDoNothing()
            .returning({ userId: schema.notificationEmailQueue.userId });

    return {
      ids: rows.map((r) => r.user_id),
      inApp: inApp.length,
      email: email.length,
      pushUsers: winners.filter((w) => w.media.push).map((w) => w.userId),
      cooledDown: candidates.length - winners.length,
    };
  });

  // After commit. A failure here retries the page, which passes the cooldown again (same event):
  // in-app rows and the email queue dedupe in SQL, and the Discord and next-page jobs by id. Push
  // jobs dedupe by id only while BullMQ still holds them (completed jobs are evicted), so push goes
  // last: a failing Discord or next-page enqueue cannot re-send pushes. A full re-run of the same
  // event (outbox redelivery, a stalled job) still can; durable push dedupe is N1-push's to add.
  const ref = { eventId: g.eventId, channelId: g.channelId, broadcastId: g.broadcastId };
  if (job.after === null) {
    const [hook] = await ctx.db
      .select({ channelId: schema.discordWebhooks.channelId })
      .from(schema.discordWebhooks)
      .where(eq(schema.discordWebhooks.channelId, g.channelId));
    if (hook) {
      const d = discordJob(ref);
      await ctx.enqueue(QUEUES.notifications, d.name, d.data, d.opts);
    }
  }
  const next = nextPageJob(g.eventId, page.ids, pageSize);
  if (next) await ctx.enqueue(QUEUES.notifications, next.name, next.data, next.opts);
  if (page.pushUsers.length > 0) await ctx.enqueueBulk(QUEUES.notifications, pushJobs(ref, page.pushUsers));

  const result: GoLiveResult = {
    followers: page.ids.length,
    inApp: page.inApp,
    email: page.email,
    push: page.pushUsers.length,
    cooledDown: page.cooledDown,
    nextPage: next !== null,
  };
  if (result.inApp > 0) fanoutMetrics.goLiveRows.add(result.inApp, { medium: "in_app" });
  if (result.email > 0) fanoutMetrics.goLiveRows.add(result.email, { medium: "email" });
  if (result.push > 0) fanoutMetrics.goLiveRows.add(result.push, { medium: "push" });
  if (result.cooledDown > 0) fanoutMetrics.cooledDown.add(result.cooledDown);
  ctx.logger.info("go-live page fanned out", {
    eventId: g.eventId,
    channelId: g.channelId,
    firstPage: job.after === null,
    ...result,
  });
  return result;
}
