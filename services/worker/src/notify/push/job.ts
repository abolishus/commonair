// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `push` job (ADR 0028 decisions 1, 6 and 8): one go-live to every browser of one member.
 * The payload is the member's in-app `go_live` row when there is one, so push and the bell agree;
 * otherwise it is built here from the broadcast with the same mature rule (contract step §0).
 */
import { GoLiveNotificationPayload, NOTIFY_RULES, type PushPayload } from "@commonair/contracts/notify";
import type { PushJob } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { and, desc, eq } from "drizzle-orm";
import type { WorkerContext } from "../../context.ts";
import { metrics } from "./metrics.ts";
import { sendPush, type PushOutcome } from "./send.ts";
import { vapidSigningKey } from "./vapid.ts";

const { pushSubscriptions, notifications, broadcasts, channels, users } = schema;

/** Title bound of `PushPayload` (and of the in-app payload). */
const TITLE_MAX = 140;

export interface PushJobResult {
  sent: number;
  removed: number;
}

/** `VAPID_PRIVATE_KEY` does not import: no subscription is touched, and the job retries. */
export class VapidKeyUnusable extends Error {
  constructor() {
    super("VAPID_PRIVATE_KEY is not a P-256 PKCS#8 key; no push sent");
    this.name = "VapidKeyUnusable";
  }
}

export class PushRetry extends Error {
  constructor(retryable: number) {
    super(`${retryable} push send(s) will be retried`);
    this.name = "PushRetry";
  }
}

type JobCtx = Pick<WorkerContext, "db" | "logger" | "now" | "webPush"> & {
  webhooks: Pick<WorkerContext["webhooks"], "authSecret" | "resolve">;
};

/** The payload for this member and event: their `go_live` row's, else built from the broadcast. */
export async function pushPayloadFor(ctx: Pick<WorkerContext, "db">, job: PushJob): Promise<PushPayload | undefined> {
  const [row] = await ctx.db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, job.userId),
        eq(notifications.type, "go_live"),
        eq(notifications.dedupeKey, `go-live-${job.eventId}`),
      ),
    )
    .limit(1);
  const inApp = row ? GoLiveNotificationPayload.safeParse(row.payload) : undefined;
  if (inApp?.success) return { v: 1, type: "go_live", slug: inApp.data.slug, title: inApp.data.title };

  // In-app off for this member: the same rule from the same columns (`broadcasts.mature OR
  // channels.mature`, and no 18+ confirmation → no title).
  const [b] = await ctx.db
    .select({
      slug: channels.slug,
      title: broadcasts.title,
      broadcastMature: broadcasts.mature,
      channelMature: channels.mature,
      matureConfirmedAt: users.matureConfirmedAt,
    })
    .from(broadcasts)
    .innerJoin(channels, eq(channels.id, broadcasts.channelId))
    .innerJoin(users, eq(users.id, job.userId))
    .where(and(eq(broadcasts.id, job.broadcastId), eq(channels.id, job.channelId)))
    .limit(1);
  if (!b) return undefined;
  const hide = (b.broadcastMature || b.channelMature) && b.matureConfirmedAt === null;
  return { v: 1, type: "go_live", slug: b.slug, title: hide ? "" : b.title.slice(0, TITLE_MAX) };
}

/**
 * Send to each of the member's subscriptions (newest first, at most the per-member cap). When any
 * send is retryable, throw after the others are done so BullMQ retries the job: a retry re-sends to
 * the ones that succeeded, and the service worker's per-channel tag makes the duplicate replace
 * the first notification. A retry does not count 400/401/403 again (`attemptsMade` > 0).
 */
export async function runPushJob(
  ctx: JobCtx,
  job: PushJob,
  meta: { attemptsMade: number } = { attemptsMade: 0 },
): Promise<PushJobResult> {
  const push = ctx.webPush;
  // Push was turned off after the fan-out enqueued this.
  if (!push) return { sent: 0, removed: 0 };
  const rows = await ctx.db
    .select({ id: pushSubscriptions.id, subscription: pushSubscriptions.subscription })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, job.userId))
    .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
    .limit(NOTIFY_RULES.maxPushSubscriptionsPerUser);
  if (rows.length === 0) return { sent: 0, removed: 0 };
  const payload = await pushPayloadFor(ctx, job);
  if (!payload) return { sent: 0, removed: 0 };
  try {
    await vapidSigningKey(push.privateKeyPkcs8);
  } catch {
    // The operator's key, not the browsers': fail loudly before any row is looked at.
    ctx.logger.error("VAPID_PRIVATE_KEY cannot be imported; push is not sent until it is fixed");
    throw new VapidKeyUnusable();
  }
  const countRefusal = meta.attemptsMade === 0;

  const outcomes: PushOutcome[] = [];
  for (const row of rows) {
    let outcome: PushOutcome;
    try {
      outcome = await sendPush(ctx, push, row, payload, job.channelId, { countRefusal });
    } catch (err) {
      // A database hiccup on one row must not stop the others; the job retries.
      ctx.logger.error("push send failed", {
        subscriptionId: row.id,
        error: err instanceof Error ? err.message : "unknown",
      });
      outcome = "retry";
    }
    metrics.pushSends.add(1, { outcome });
    outcomes.push(outcome);
  }
  const count = (o: PushOutcome) => outcomes.filter((x) => x === o).length;
  const retryable = count("retry");
  if (retryable > 0) throw new PushRetry(retryable);
  return { sent: count("sent"), removed: count("removed") };
}
