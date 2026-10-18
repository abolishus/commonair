// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Webhook transport: fan-out, notification delivery with retries, callback
 * verification, revocation, test events and redelivery. Every POST is logged
 * in `webhook_deliveries`.
 */
import { EVENTS, type EventType } from "@commonair/contracts/events";
import { QUEUES } from "@commonair/contracts/internal";
import { schema, uuidv7 } from "@commonair/db";
import { decryptSecret, randomSecret } from "@commonair/tokens";
import { and, desc, eq, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { WEBHOOK_JOBS, type DeliverJob } from "../jobs/names.ts";
import { metrics } from "../metrics.ts";
import { authorize } from "./authorization.ts";
import { nextRetryDelay } from "./backoff.ts";
import { matchesCondition } from "./conditions.ts";
import { postWebhook, type PostResult } from "./http.ts";
import {
  ENVELOPE_STATUS,
  envelope,
  notificationMessageId,
  signedHeaders,
  truncateUtf8,
  type MessageType,
  type SubscriptionRow,
} from "./messages.ts";
import { samplePayload } from "./sample.ts";

const { eventSubscriptions: subs, webhookDeliveries: deliveries, events } = schema;

const isEventType = (t: string): t is EventType => Object.hasOwn(EVENTS, t);

export async function loadSubscription(ctx: WorkerContext, id: string): Promise<SubscriptionRow | undefined> {
  const [row] = await ctx.db.select().from(subs).where(eq(subs.id, id)).limit(1);
  return row;
}

interface SendInput {
  sub: SubscriptionRow;
  messageType: MessageType;
  messageId: string;
  eventId: string;
  attempt: number;
  body: string;
}

export interface SendOutcome {
  deliveryId: string;
  success: boolean;
  result: PostResult;
}

/** Sign, POST and log one message. Never throws for receiver-side failures. */
async function send(ctx: WorkerContext, input: SendInput, nextAttemptAt: (ok: boolean) => Date | null) {
  const { sub } = input;
  const cfg = ctx.webhooks;
  let result: PostResult;
  if (!sub.callbackUrl || !sub.secretCiphertext) {
    result = { ok: false, error: "subscription has no callback or secret", latencyMs: 0, rejected: true };
  } else {
    let secret: string | undefined;
    try {
      secret = await decryptSecret(cfg.authSecret, "webhook", sub.secretCiphertext);
    } catch {
      secret = undefined;
    }
    if (secret === undefined) {
      result = { ok: false, error: "webhook secret cannot be decrypted", latencyMs: 0, rejected: true };
    } else {
      const headers = await signedHeaders({
        secret,
        messageId: input.messageId,
        messageType: input.messageType,
        timestamp: ctx.now().toISOString(),
        body: input.body,
        subscription: sub,
        retry: input.attempt - 1,
      });
      result = await postWebhook(sub.callbackUrl, headers, input.body, {
        allowInsecure: cfg.allowInsecure,
        timeoutMs: cfg.timeoutMs,
        maxResponseBytes: cfg.maxResponseBytes,
        resolve: cfg.resolve,
      });
    }
  }
  const success = result.ok && result.status >= 200 && result.status < 300;
  const deliveryId = uuidv7();
  await ctx.db.insert(deliveries).values({
    id: deliveryId,
    subscriptionId: sub.id,
    eventId: input.eventId,
    messageId: input.messageId,
    messageType: input.messageType,
    attempt: input.attempt,
    status: success ? "succeeded" : "failed",
    responseStatus: result.ok ? result.status : null,
    responseBody: result.ok ? truncateUtf8(result.body, cfg.logBodyBytes) : null,
    error: result.ok ? (success ? null : `HTTP ${result.status}`) : result.error,
    latencyMs: result.latencyMs,
    nextAttemptAt: nextAttemptAt(success),
  });
  metrics.webhookAttempts.add(1, { type: input.messageType, outcome: success ? "success" : "failure" });
  return { deliveryId, success, result } satisfies SendOutcome;
}

/** Best-effort single revocation message; the subscription is already revoked/failed in the DB. */
async function sendRevocation(ctx: WorkerContext, sub: SubscriptionRow, status: string, eventId: string) {
  const body = JSON.stringify({ subscription: envelope(sub, status) });
  await send(ctx, { sub, messageType: "revocation", messageId: uuidv7(), eventId, attempt: 1, body }, () => null);
}

/** Revoke (once) and tell the receiver. Returns false if another worker got there first. */
export async function revoke(
  ctx: WorkerContext,
  sub: SubscriptionRow,
  eventId: string,
  reason: string,
): Promise<boolean> {
  const updated = await ctx.db
    .update(subs)
    .set({ status: "revoked" })
    .where(and(eq(subs.id, sub.id), sql`${subs.status} <> 'revoked'`))
    .returning({ id: subs.id });
  if (updated.length === 0) return false;
  ctx.logger.info("webhook subscription revoked", { subscriptionId: sub.id, type: sub.type, reason });
  await sendRevocation(ctx, { ...sub, status: "revoked" }, ENVELOPE_STATUS.revoked, eventId);
  return true;
}

/** Find the enabled webhook subscriptions an outbox event matches and enqueue one delivery each. */
export async function fanOut(ctx: WorkerContext, eventId: string): Promise<number> {
  const [event] = await ctx.db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event || !isEventType(event.type)) return 0;
  const broadcaster = event.payload.broadcaster_user_id;
  const candidates = await ctx.db
    .select()
    .from(subs)
    .where(
      and(
        eq(subs.transport, "webhook"),
        eq(subs.status, "enabled"),
        eq(subs.type, event.type),
        eq(subs.version, event.version),
        // Index-friendly prefilter; matchesCondition below is the authority.
        typeof broadcaster === "string"
          ? sql`(${subs.condition}->>'broadcaster_user_id' is null or ${subs.condition}->>'broadcaster_user_id' = ${broadcaster})`
          : undefined,
      ),
    );
  let queued = 0;
  for (const sub of candidates) {
    if (!matchesCondition(sub.condition, event.payload, sub.userId)) continue;
    const auth = await authorize(ctx, sub, event.type);
    if (!auth.ok) {
      await revoke(ctx, sub, event.id, auth.reason);
      continue;
    }
    await ctx.enqueue(
      QUEUES.webhooks,
      WEBHOOK_JOBS.deliver,
      { subscriptionId: sub.id, eventId: event.id, attempt: 1 } satisfies DeliverJob,
      { jobId: `deliver-${sub.id}-${event.id}-1` },
    );
    queued++;
  }
  return queued;
}

export type DeliverResult = "succeeded" | "retrying" | "exhausted" | "skipped";

/** One delivery attempt of a notification; schedules the next attempt on failure. */
export async function deliver(ctx: WorkerContext, job: DeliverJob): Promise<DeliverResult> {
  const sub = await loadSubscription(ctx, job.subscriptionId);
  if (!sub || sub.status !== "enabled" || sub.transport !== "webhook") return "skipped";
  if (!isEventType(sub.type)) return "skipped";

  let payload: Record<string, unknown>;
  if (job.sample) payload = job.sample;
  else {
    const [event] = await ctx.db.select().from(events).where(eq(events.id, job.eventId)).limit(1);
    if (!event) return "skipped";
    payload = event.payload;
  }
  // Authorization can disappear between fan-out and a later retry; test events are checked too.
  const auth = await authorize(ctx, sub, sub.type);
  if (!auth.ok) {
    await revoke(ctx, sub, job.eventId, auth.reason);
    return "skipped";
  }

  const isTest = job.sample !== undefined;
  const maxAttempts = isTest ? 1 : ctx.webhooks.maxAttempts;
  const delay = nextRetryDelay(job.attempt, maxAttempts, ctx.webhooks.backoffMs);
  const body = JSON.stringify({ subscription: envelope(sub), event: payload });
  const outcome = await send(
    ctx,
    {
      sub,
      messageType: "notification",
      messageId: notificationMessageId(sub.id, job.eventId),
      eventId: job.eventId,
      attempt: job.attempt,
      body,
    },
    (ok) => (ok || delay === null ? null : new Date(ctx.now().getTime() + delay)),
  );

  if (outcome.success) {
    if (sub.failureCount > 0 && !isTest) await ctx.db.update(subs).set({ failureCount: 0 }).where(eq(subs.id, sub.id));
    return "succeeded";
  }
  if (delay !== null) {
    const next = job.attempt + 1;
    await ctx.enqueue(QUEUES.webhooks, WEBHOOK_JOBS.deliver, { ...job, attempt: next } satisfies DeliverJob, {
      jobId: `deliver-${sub.id}-${job.eventId}-${next}`,
      delayMs: delay,
    });
    return "retrying";
  }
  if (!isTest) await recordExhausted(ctx, sub, job.eventId);
  return "exhausted";
}

/** An event used up every attempt: count it, and fail the subscription after N in a row. */
async function recordExhausted(ctx: WorkerContext, sub: SubscriptionRow, eventId: string) {
  const threshold = ctx.webhooks.failureThreshold;
  const [row] = await ctx.db
    .update(subs)
    .set({
      failureCount: sql`${subs.failureCount} + 1`,
      status: sql`case when ${subs.failureCount} + 1 >= ${threshold} then 'failed'::event_subscription_state else ${subs.status} end`,
    })
    .where(and(eq(subs.id, sub.id), eq(subs.status, "enabled")))
    .returning({ status: subs.status, failureCount: subs.failureCount });
  if (row?.status === "failed") {
    ctx.logger.warn("webhook subscription failed after consecutive undelivered events", {
      subscriptionId: sub.id,
      failures: row.failureCount,
    });
    await sendRevocation(ctx, { ...sub, status: "failed" }, ENVELOPE_STATUS.failed, eventId);
  }
}

/**
 * Callback verification: the receiver must answer 200 with the challenge as the
 * whole body (surrounding whitespace tolerated) within the timeout.
 */
export async function verifyCallback(
  ctx: WorkerContext,
  subscriptionId: string,
): Promise<"enabled" | "failed" | "skipped"> {
  const sub = await loadSubscription(ctx, subscriptionId);
  if (!sub || sub.status !== "verification_pending" || sub.transport !== "webhook") return "skipped";
  const challenge = randomSecret("", 24);
  const body = JSON.stringify({ subscription: envelope(sub), challenge });
  const outcome = await send(
    ctx,
    { sub, messageType: "webhook_callback_verification", messageId: uuidv7(), eventId: uuidv7(), attempt: 1, body },
    () => null,
  );
  const echoed = outcome.result.ok && outcome.result.status === 200 && outcome.result.body.trim() === challenge;
  const status = echoed ? "enabled" : "failed";
  await ctx.db
    .update(subs)
    .set({ status })
    .where(and(eq(subs.id, sub.id), eq(subs.status, "verification_pending")));
  if (!echoed && outcome.success) {
    // 2xx without the challenge is still a failed verification; make the log row say why.
    await ctx.db
      .update(deliveries)
      .set({ status: "failed", error: "challenge not echoed" })
      .where(eq(deliveries.id, outcome.deliveryId));
  }
  return status;
}

/** Synthesize a catalog-valid event for the subscription and deliver it once. */
export async function sendTestEvent(ctx: WorkerContext, subscriptionId: string, eventId?: string) {
  const sub = await loadSubscription(ctx, subscriptionId);
  if (!sub || sub.transport !== "webhook" || !isEventType(sub.type)) return "skipped" as const;
  const sample = samplePayload(sub.type, sub.condition);
  return deliver(ctx, { subscriptionId: sub.id, eventId: eventId ?? uuidv7(), attempt: 1, sample });
}

/**
 * Manual redelivery of a logged notification: one more attempt with the same
 * message id (it is the same message), not followed by automatic retries.
 */
export async function redeliver(ctx: WorkerContext, deliveryId: string): Promise<"succeeded" | "failed" | "skipped"> {
  const [prior] = await ctx.db.select().from(deliveries).where(eq(deliveries.id, deliveryId)).limit(1);
  if (!prior || prior.messageType !== "notification") return "skipped";
  const sub = await loadSubscription(ctx, prior.subscriptionId);
  if (!sub || sub.status !== "enabled" || !isEventType(sub.type)) return "skipped";
  const [event] = await ctx.db.select().from(events).where(eq(events.id, prior.eventId)).limit(1);
  if (!event) return "skipped"; // test events have no outbox row and cannot be replayed
  const auth = await authorize(ctx, sub, sub.type);
  if (!auth.ok) {
    await revoke(ctx, sub, event.id, auth.reason);
    return "skipped";
  }
  const [last] = await ctx.db
    .select({ attempt: deliveries.attempt })
    .from(deliveries)
    .where(and(eq(deliveries.subscriptionId, sub.id), eq(deliveries.messageId, prior.messageId)))
    .orderBy(desc(deliveries.attempt))
    .limit(1);
  const body = JSON.stringify({ subscription: envelope(sub), event: event.payload });
  const outcome = await send(
    ctx,
    {
      sub,
      messageType: "notification",
      messageId: prior.messageId,
      eventId: event.id,
      attempt: (last?.attempt ?? prior.attempt) + 1,
      body,
    },
    () => null,
  );
  return outcome.success ? "succeeded" : "failed";
}
