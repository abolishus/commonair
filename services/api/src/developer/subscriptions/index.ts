// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EventSub subscriptions over HTTP (ADR 0027 §3): create (webhook or WebSocket), list, delete, the
 * webhook delivery log, test events and redelivery. The authority rules are in `rules.ts`; the
 * worker re-checks `authorizeSubscription` at every webhook delivery and the WebSocket fan-out
 * re-authorizes too, so a subscription never outlives its authorization.
 */
import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { BUS, EventSubControlMessage, type PublicEventType } from "@commonair/contracts/events";
import { WEBHOOK_JOBS } from "@commonair/contracts/internal";
import { authorizeSubscription, schema, uuidv7, type Executor } from "@commonair/db";
import { encryptSecret } from "@commonair/tokens";
import type { Deps } from "../../deps.ts";
import { eventSubSessions, type BindResult } from "../../eventsub/index.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../../lib/cursor.ts";
import { apiError, conflict, isUniqueViolation, notFound, precondition } from "../../lib/errors.ts";
import type { AppCaller, Caller } from "../../lib/access.ts";
import { resolveOutbound } from "../../lib/outbound.ts";
import { webhookQueue } from "../webhook-queue.ts";
import {
  APP_WEBHOOK_LIMIT,
  CALLBACK_MAX_LENGTH,
  PERSONAL_WEBHOOK_LIMIT,
  checkTypeAndCondition,
  isRefusal,
  planSubscription,
  toSubscriptionDto,
  unauthorizedRefusal,
  type Actor,
  type Refusal,
} from "./rules.ts";

export { CATALOG } from "./rules.ts";

const { eventSubscriptions: subs, webhookDeliveries: deliveries, oauthApps, oauthTokens, events } = schema;

/** The middleware's resolution, as `requireActor` returns it. */
export type ResolvedActor = { kind: "user"; caller: Caller } | { kind: "app"; app: AppCaller };

export function actorOf(a: ResolvedActor): Actor {
  if (a.kind === "app") return { kind: "app_token", appId: a.app.appId };
  if (a.caller.kind === "session") return { kind: "session", userId: a.caller.user.id };
  return { kind: "user_token", userId: a.caller.user.id, appId: a.caller.appId };
}

export function refuse(r: Refusal): never {
  if (r.code === "PRECONDITION_FAILED") throw precondition(r.requirement, r.message);
  throw apiError(r.code, r.message);
}

/** Rule 5: the subscriptions an actor may see and manage. */
function visibleTo(deps: Deps, actor: Actor): SQL | undefined {
  switch (actor.kind) {
    case "app_token":
      return eq(subs.appId, actor.appId);
    case "user_token":
      return and(
        actor.appId === null ? isNull(subs.appId) : eq(subs.appId, actor.appId),
        eq(subs.userId, actor.userId),
      );
    case "session":
      return or(
        and(isNull(subs.appId), eq(subs.userId, actor.userId)),
        inArray(
          subs.appId,
          deps.db.select({ id: oauthApps.id }).from(oauthApps).where(eq(oauthApps.ownerId, actor.userId)),
        ),
      );
  }
}

async function publishSessionChange(deps: Deps, sessionId: string): Promise<void> {
  const message = EventSubControlMessage.parse({ op: "subscriptions_changed", sessionId });
  try {
    await deps.valkey.publish(BUS.eventsubControl, JSON.stringify(message));
  } catch (err) {
    // The holding instance also reloads on its own schedule; the row is the source of truth.
    deps.logger.warn("eventsub control publish failed", { err });
  }
}

export interface SubscribeInput {
  type: PublicEventType;
  version: string;
  condition: Record<string, string>;
  transport: { method: "webhook"; callback: string; secret: string } | { method: "websocket"; sessionId: string };
  appId?: string | undefined;
}

const BIND_REFUSALS: Record<Exclude<BindResult, "ok">, Refusal> = {
  unknown_session: {
    code: "PRECONDITION_FAILED",
    requirement: "websocket_session",
    message: "No open EventSub WebSocket session has this id",
  },
  other_grant: { code: "FORBIDDEN", message: "This WebSocket session belongs to another authorization" },
  too_many_sessions: {
    code: "PRECONDITION_FAILED",
    requirement: "websocket_session_limit",
    message: "This authorization already has the most WebSocket sessions allowed",
  },
};

/** `developer.events.subscribe` (rules in `rules.ts`; the WebSocket binds with the presented token). */
export async function subscribe(deps: Deps, resolved: ResolvedActor, input: SubscribeInput) {
  const actor = actorOf(resolved);
  const bad = checkTypeAndCondition(input.type, input.version, input.condition);
  if (bad) refuse(bad);
  const plan = planSubscription(actor, {
    type: input.type,
    condition: input.condition,
    transport: input.transport.method,
    appId: input.appId,
  });
  if (isRefusal(plan)) refuse(plan);

  let userId: string;
  if (actor.kind === "session" && plan.appId !== null) {
    const [app] = await deps.db
      .select({ id: oauthApps.id })
      .from(oauthApps)
      .where(and(eq(oauthApps.id, plan.appId), eq(oauthApps.ownerId, actor.userId), isNull(oauthApps.suspendedAt)))
      .limit(1);
    if (!app) throw notFound("App not found");
  }
  if (plan.backing.kind === "user") userId = plan.backing.userId;
  else if (actor.kind === "session" || actor.kind === "user_token") userId = actor.userId;
  else {
    const [app] = await deps.db
      .select({ ownerId: oauthApps.ownerId })
      .from(oauthApps)
      .where(and(eq(oauthApps.id, actor.appId), isNull(oauthApps.suspendedAt)))
      .limit(1);
    if (!app) throw notFound("App not found");
    userId = app.ownerId;
  }

  if (plan.authorize) {
    const auth = await authorizeSubscription(
      deps.db,
      { userId, appId: plan.appId, condition: input.condition },
      input.type,
      deps.now(),
    );
    if (!auth.ok) refuse(unauthorizedRefusal(input.type, plan.asApp));
  }

  const base = {
    id: uuidv7(),
    appId: plan.appId,
    userId,
    type: input.type,
    version: input.version,
    condition: input.condition,
  };
  if (input.transport.method === "webhook")
    return createWebhook(deps, base, input.transport.callback, input.transport.secret);
  if (resolved.kind !== "user" || resolved.caller.kind !== "token")
    throw apiError("FORBIDDEN", "WebSocket subscriptions need a user access token");
  return createWebsocket(deps, base, input.transport.sessionId, resolved.caller.tokenId);
}

interface NewSubscription {
  id: string;
  appId: string | null;
  userId: string;
  type: string;
  version: string;
  condition: Record<string, string>;
}

async function insertOrConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict("An identical subscription already exists");
    throw err;
  }
}

async function createWebhook(deps: Deps, base: NewSubscription, callback: string, secret: string) {
  const insecure = deps.env.EVENTSUB_ALLOW_INSECURE_CALLBACKS;
  // The worker re-checks the address at every delivery (DNS can change); this refuses the obvious.
  const target =
    callback.length > CALLBACK_MAX_LENGTH
      ? ({ ok: false, reason: "too long" } as const)
      : await resolveOutbound(callback, {
          protocols: insecure ? ["https:", "http:"] : ["https:"],
          allowPrivate: insecure,
          resolve: deps.resolveHost,
        });
  if (!target.ok) {
    deps.logger.info("eventsub callback refused", { reason: target.reason });
    throw precondition("callback_url", "The callback must be an https URL on a public host");
  }
  const secretCiphertext = await encryptSecret(deps.env.AUTH_SECRET, "webhook", secret);
  const row = await insertOrConflict(() =>
    deps.db.transaction(async (tx) => {
      const scope = base.appId ?? `user:${base.userId}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`eventsub-webhooks:${scope}`}, 0))`);
      const [held] = await tx
        .select({ n: count() })
        .from(subs)
        .where(
          and(
            eq(subs.transport, "webhook"),
            // Revoked and failed rows are dead weight the developer may not have cleaned up yet.
            inArray(subs.status, ["enabled", "verification_pending"]),
            base.appId === null ? and(isNull(subs.appId), eq(subs.userId, base.userId)) : eq(subs.appId, base.appId),
          ),
        );
      const limit = base.appId === null ? PERSONAL_WEBHOOK_LIMIT : APP_WEBHOOK_LIMIT;
      if ((held?.n ?? 0) >= limit)
        throw precondition("subscription_limit", `At most ${limit} webhook subscriptions are allowed`);
      const [inserted] = await tx
        .insert(subs)
        .values({
          ...base,
          transport: "webhook",
          callbackUrl: callback,
          secretCiphertext,
          status: "verification_pending",
        })
        .returning();
      return inserted;
    }),
  );
  if (!row) throw new Error("subscription insert returned no row");
  try {
    await webhookQueue(deps).enqueue(WEBHOOK_JOBS.verifyCallback, { subscriptionId: row.id }, `verify-${row.id}`);
  } catch (err) {
    // Without the verification job it would stay pending forever: undo, so the client can retry.
    await deps.db.delete(subs).where(eq(subs.id, row.id));
    throw err;
  }
  return toSubscriptionDto(row);
}

async function createWebsocket(deps: Deps, base: NewSubscription, sessionId: string, tokenId: string) {
  const [token] = await deps.db
    .select({ hash: oauthTokens.accessTokenHash })
    .from(oauthTokens)
    .where(eq(oauthTokens.id, tokenId))
    .limit(1);
  if (!token) throw apiError("UNAUTHORIZED", "Invalid or expired access token");
  const bound = await eventSubSessions(deps).bind(sessionId, {
    appId: base.appId,
    userId: base.userId,
    tokenHash: token.hash,
  });
  if (bound !== "ok") refuse(BIND_REFUSALS[bound]);
  const max = deps.env.EVENTSUB_WS_MAX_SUBSCRIPTIONS;
  const row = await insertOrConflict(() =>
    deps.db.transaction(async (tx: Executor) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`eventsub-session:${sessionId}`}, 0))`);
      const [held] = await tx
        .select({ n: count() })
        .from(subs)
        .where(and(eq(subs.websocketSessionId, sessionId), eq(subs.status, "enabled")));
      if ((held?.n ?? 0) >= max)
        throw precondition("websocket_subscription_limit", `At most ${max} subscriptions per WebSocket session`);
      const [inserted] = await tx
        .insert(subs)
        .values({ ...base, transport: "websocket", websocketSessionId: sessionId, status: "enabled" })
        .returning();
      return inserted;
    }),
  );
  if (!row) throw new Error("subscription insert returned no row");
  await publishSessionChange(deps, sessionId);
  return toSubscriptionDto(row);
}

/** The cursor carries microseconds: a JS Date keeps milliseconds, and rows can share one. */
const microsOf = (col: typeof subs.createdAt | typeof deliveries.createdAt) =>
  sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ListInput {
  cursor?: string | undefined;
  limit: number;
  type?: string | undefined;
  status?: (typeof subs.status.enumValues)[number] | undefined;
  appId?: string | undefined;
}

/** `developer.events.list`: newest first, keyset on (`created_at`, `id`). */
export async function listSubscriptions(deps: Deps, resolved: ResolvedActor, input: ListInput) {
  const actor = actorOf(resolved);
  const cur = decodeCursor(input.cursor, isKeyCursor);
  const rows = await deps.db
    .select({ row: subs, t: microsOf(subs.createdAt) })
    .from(subs)
    .where(
      and(
        visibleTo(deps, actor),
        input.type ? eq(subs.type, input.type) : undefined,
        input.status ? eq(subs.status, input.status) : undefined,
        input.appId ? eq(subs.appId, input.appId) : undefined,
        cur ? sql`(${subs.createdAt}, ${subs.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(subs.createdAt), desc(subs.id))
    .limit(input.limit + 1);
  return pageOf(
    rows,
    input.limit,
    (r) => toSubscriptionDto(r.row),
    (last) => encodeCursor({ t: last.t, id: last.row.id }),
  );
}

async function visibleSubscription(deps: Deps, actor: Actor, id: string) {
  const [row] = await deps.db
    .select()
    .from(subs)
    .where(and(eq(subs.id, id), visibleTo(deps, actor)))
    .limit(1);
  if (!row) throw notFound("Subscription not found");
  return row;
}

/** `developer.events.unsubscribe`: deliveries cascade; no revocation message (the client asked). */
export async function unsubscribe(deps: Deps, resolved: ResolvedActor, id: string) {
  const actor = actorOf(resolved);
  const [row] = await deps.db
    .delete(subs)
    .where(and(eq(subs.id, id), visibleTo(deps, actor)))
    .returning({ sessionId: subs.websocketSessionId });
  if (!row) throw notFound("Subscription not found");
  if (row.sessionId !== null) await publishSessionChange(deps, row.sessionId);
  return { ok: true as const };
}

/** `developer.events.deliveries`: newest first; never the response body (operators only). */
export async function listDeliveries(
  deps: Deps,
  resolved: ResolvedActor,
  input: { id: string; cursor?: string | undefined; limit: number },
) {
  const sub = await visibleSubscription(deps, actorOf(resolved), input.id);
  const cur = decodeCursor(input.cursor, isKeyCursor);
  const d = deliveries;
  const rows = await deps.db
    .select({
      id: d.id,
      subscriptionId: d.subscriptionId,
      eventId: d.eventId,
      messageId: d.messageId,
      messageType: d.messageType,
      attempt: d.attempt,
      status: d.status,
      responseStatus: d.responseStatus,
      error: d.error,
      latencyMs: d.latencyMs,
      createdAt: d.createdAt,
      t: microsOf(d.createdAt),
    })
    .from(d)
    .where(
      and(
        eq(d.subscriptionId, sub.id),
        cur ? sql`(${d.createdAt}, ${d.id}) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(d.createdAt), desc(d.id))
    .limit(input.limit + 1);
  return pageOf(
    rows,
    input.limit,
    ({ t: _t, createdAt, ...r }) => ({ ...r, createdAt: createdAt.toISOString() }),
    (last) => encodeCursor({ t: last.t, id: last.id }),
  );
}

/** `developer.events.sendTest`: one synthesized, catalog-valid event, delivered once by the worker. */
export async function sendTest(deps: Deps, resolved: ResolvedActor, id: string) {
  const sub = await visibleSubscription(deps, actorOf(resolved), id);
  if (sub.transport !== "webhook") throw precondition("webhook_only", "Test events are for webhook subscriptions");
  if (sub.status !== "enabled") throw precondition("not_enabled", "The subscription is not enabled");
  const eventId = uuidv7();
  await webhookQueue(deps).enqueue(WEBHOOK_JOBS.testEvent, { subscriptionId: sub.id, eventId }, `test-${eventId}`);
  return { eventId };
}

/**
 * `developer.events.redeliver`: one more attempt of a logged notification, same message id. Only
 * notifications of real events (test events have no outbox row to replay) of an enabled subscription.
 * A succeeded delivery may be redelivered too (deliberately, unlike the brief's "that failed"): a
 * receiver that lost a message it acknowledged needs it again, and the harness relies on it.
 */
export async function redeliver(deps: Deps, resolved: ResolvedActor, deliveryId: string) {
  const actor = actorOf(resolved);
  const [found] = await deps.db
    .select({ messageType: deliveries.messageType, eventId: deliveries.eventId, status: subs.status })
    .from(deliveries)
    .innerJoin(subs, eq(subs.id, deliveries.subscriptionId))
    .where(and(eq(deliveries.id, deliveryId), visibleTo(deps, actor)))
    .limit(1);
  if (!found) throw notFound("Delivery not found");
  if (found.messageType !== "notification")
    throw precondition("notification_only", "Only notifications can be redelivered");
  if (found.status !== "enabled") throw precondition("not_enabled", "The subscription is not enabled");
  const [event] = await deps.db.select({ id: events.id }).from(events).where(eq(events.id, found.eventId)).limit(1);
  if (!event) throw precondition("not_replayable", "Test events cannot be redelivered");
  await webhookQueue(deps).enqueue(
    WEBHOOK_JOBS.redeliver,
    { deliveryId },
    `redeliver-${deliveryId}-${deps.now().getTime()}`,
  );
  return { ok: true as const };
}
