// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EventSub authorization queries shared by the API (subscribe, WebSocket fan-out) and the worker
 * (webhook delivery). Subscribe-time and delivery-time checks use the same rules, re-checked on
 * every delivery because tokens are revoked and moderators removed after a subscription exists.
 */
import { createHash } from "node:crypto";
import { bindingFor, broadcasterOf, conditionComplete } from "@commonair/contracts/eventsub";
import { EVENTS, type EventType } from "@commonair/contracts/events";
import { and, arrayContains, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "./client.ts";
import { oauthApps, oauthTokens } from "./schema/platform.ts";

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

interface SubscriptionAuthority {
  userId: string;
  appId: string | null;
  condition: Record<string, string>;
}

async function hasToken(db: Executor, sub: SubscriptionAuthority, scopes: readonly string[], now: Date) {
  const t = oauthTokens;
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.userId, sub.userId),
        // Subscriptions without an app are backed by the user's personal tokens.
        sub.appId === null ? isNull(t.appId) : eq(t.appId, sub.appId),
        isNull(t.revokedAt),
        // An expired access token still represents a live grant while its refresh token is good.
        or(gt(t.expiresAt, now), and(isNotNull(t.refreshTokenHash), gt(t.refreshExpiresAt, now))),
        arrayContains(t.scopes, [...scopes]),
        sql`not exists (select 1 from ${oauthApps} where ${oauthApps.id} = ${t.appId} and ${oauthApps.suspendedAt} is not null)`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function isModerator(db: Executor, broadcasterUserId: string, userId: string) {
  const rows = await db.execute(sql`
    select 1 from channel_roles r join channels c on c.id = r.channel_id
     where c.owner_id = ${broadcasterUserId}::uuid and r.user_id = ${userId}::uuid and r.role = 'moderator'
     limit 1`);
  return rows.length > 0;
}

async function appSuspended(db: Executor, appId: string) {
  const rows = await db
    .select({ id: oauthApps.id })
    .from(oauthApps)
    .where(and(eq(oauthApps.id, appId), isNotNull(oauthApps.suspendedAt)))
    .limit(1);
  return rows.length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Delivery- and subscribe-time authorization of a subscription (ADR 0027 §1). */
export async function authorizeSubscription(
  db: Executor,
  sub: SubscriptionAuthority,
  type: EventType,
  now: Date,
): Promise<AuthorizationResult> {
  if (!conditionComplete(type, sub.condition)) return { ok: false, reason: "condition incomplete" };
  const scopes = EVENTS[type].scopes;
  const binding = bindingFor(scopes);
  if (binding === "none") {
    // No token is consulted here, so the app's suspension must be checked on its own.
    if (sub.appId !== null && (await appSuspended(db, sub.appId))) return { ok: false, reason: "app suspended" };
    return { ok: true };
  }
  if (!(await hasToken(db, sub, scopes, now))) return { ok: false, reason: "missing authorization" };
  if (binding === "self") {
    return sub.condition.user_id === sub.userId ? { ok: true } : { ok: false, reason: "user_id is not the subscriber" };
  }
  const broadcaster = broadcasterOf(sub.condition);
  if (!broadcaster) return { ok: false, reason: "condition names no broadcaster" };
  if (broadcaster === sub.userId) return { ok: true };
  if (
    binding === "broadcaster_or_moderator" &&
    UUID.test(broadcaster) &&
    (await isModerator(db, broadcaster, sub.userId))
  )
    return { ok: true };
  return { ok: false, reason: "subscriber is not the broadcaster" };
}

/**
 * Message id for (subscription, event): deterministic, so every retry, any duplicate fan-out of the
 * same event and both transports carry the same id and receivers dedupe.
 */
export function notificationMessageId(subscriptionId: string, eventId: string): string {
  const h = createHash("sha256").update(`notification:${subscriptionId}:${eventId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
