// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Delivery-time authorization of a webhook subscription. The API checks the
 * same rules at subscribe time; the worker re-checks on every delivery because
 * tokens are revoked and moderators removed after a subscription exists.
 */
import { EVENTS, type EventType } from "@commonair/contracts/events";
import { schema } from "@commonair/db";
import { and, arrayContains, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { SubscriptionRow } from "./messages.ts";

/**
 * Who the authorizing user must be, relative to the condition, for scoped events:
 * - `moderator:*` scopes: the broadcaster or one of the channel's moderators;
 * - `chat:read` only: the reading user named in `user_id` (chat is public, so any
 *   user may read it as themselves, as on Twitch);
 * - any other scope (subscriptions, tips, polls, points…): the broadcaster.
 */
export type Binding = "none" | "broadcaster" | "broadcaster_or_moderator" | "self";

export function bindingFor(scopes: readonly string[]): Binding {
  if (scopes.length === 0) return "none";
  if (scopes.some((s) => s.startsWith("moderator:"))) return "broadcaster_or_moderator";
  if (scopes.every((s) => s === "chat:read")) return "self";
  return "broadcaster";
}

/** Every condition field the catalog defines for the type must be present and non-empty. */
export function conditionComplete(type: EventType, condition: Record<string, string>): boolean {
  return EVENTS[type].condition.every((k) => Object.hasOwn(condition, k) && condition[k] !== "");
}

/** The condition field naming the channel owner (raids name the receiving broadcaster). */
export function broadcasterOf(condition: Record<string, string>): string | undefined {
  return condition.broadcaster_user_id ?? condition.to_broadcaster_user_id;
}

export type AuthorizationResult = { ok: true } | { ok: false; reason: string };

async function hasToken(ctx: WorkerContext, sub: SubscriptionRow, scopes: readonly string[]) {
  const t = schema.oauthTokens;
  const rows = await ctx.db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.userId, sub.userId),
        // Subscriptions without an app are backed by the user's personal tokens.
        sub.appId === null ? isNull(t.appId) : eq(t.appId, sub.appId),
        isNull(t.revokedAt),
        // An expired access token still represents a live grant while it can be refreshed.
        or(gt(t.expiresAt, ctx.now()), isNotNull(t.refreshTokenHash)),
        arrayContains(t.scopes, [...scopes]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function isModerator(ctx: WorkerContext, broadcasterUserId: string, userId: string) {
  const rows = await ctx.sql`
    select 1 from channel_roles r join channels c on c.id = r.channel_id
     where c.owner_id = ${broadcasterUserId}::uuid and r.user_id = ${userId}::uuid and r.role = 'moderator'
     limit 1`;
  return rows.length > 0;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authorize(
  ctx: WorkerContext,
  sub: SubscriptionRow,
  type: EventType,
): Promise<AuthorizationResult> {
  if (!conditionComplete(type, sub.condition)) return { ok: false, reason: "condition incomplete" };
  const scopes = EVENTS[type].scopes;
  const binding = bindingFor(scopes);
  if (binding === "none") return { ok: true };
  if (!(await hasToken(ctx, sub, scopes))) return { ok: false, reason: "missing authorization" };
  if (binding === "self") {
    return sub.condition.user_id === sub.userId ? { ok: true } : { ok: false, reason: "user_id is not the subscriber" };
  }
  const broadcaster = broadcasterOf(sub.condition);
  if (!broadcaster) return { ok: false, reason: "condition names no broadcaster" };
  if (broadcaster === sub.userId) return { ok: true };
  if (
    binding === "broadcaster_or_moderator" &&
    UUID.test(broadcaster) &&
    (await isModerator(ctx, broadcaster, sub.userId))
  )
    return { ok: true };
  return { ok: false, reason: "subscriber is not the broadcaster" };
}
