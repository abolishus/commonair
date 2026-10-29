// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** EventSub rules shared by the API (subscribe, WebSocket fan-out), the worker (webhooks) and the SDK. */
import type { z } from "zod";
import type { EVENT_TRANSPORTS, SUBSCRIPTION_STATES } from "./enums.ts";
import { EVENTS, SubscriptionEnvelope, type EventType, type PublicEventType } from "./events.ts";

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

/** Payload scalars compared with condition values, which are always strings on the wire. */
function asConditionValue(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/**
 * Does an event payload satisfy a subscription condition? Every condition key must
 * equal the payload field of the same name. `user_id` follows Twitch semantics when
 * the payload has no such field (e.g. `channel.chat.message`): it names the user whose
 * authorization backs the subscription, so it must equal the subscription's user.
 * An empty condition matches every event of the type.
 */
export function matchesCondition(
  condition: Record<string, string>,
  payload: Record<string, unknown>,
  subscriptionUserId: string,
): boolean {
  for (const [key, expected] of Object.entries(condition)) {
    if (Object.hasOwn(payload, key)) {
      if (asConditionValue(payload[key]) !== expected) return false;
    } else if (key === "user_id") {
      if (expected !== subscriptionUserId) return false;
    } else return false;
  }
  return true;
}

/** Twitch-compatible status strings shown in the envelope (the DB enum is coarser). */
export const ENVELOPE_STATUS = {
  enabled: "enabled",
  verification_pending: "webhook_callback_verification_pending",
  failed: "notification_failures_exceeded",
  revoked: "authorization_revoked",
} as const;

/** Envelope for either transport (the worker's `envelope()` assumed webhook). */
export function subscriptionEnvelope(
  sub: {
    id: string;
    type: string;
    version: string;
    status: (typeof SUBSCRIPTION_STATES)[number];
    condition: Record<string, string>;
    transport: (typeof EVENT_TRANSPORTS)[number];
    callbackUrl: string | null;
    websocketSessionId: string | null;
    createdAt: Date;
  },
  status?: string,
): z.infer<typeof SubscriptionEnvelope> {
  return SubscriptionEnvelope.parse({
    id: sub.id,
    type: sub.type,
    version: sub.version,
    status: status ?? ENVELOPE_STATUS[sub.status],
    condition: sub.condition,
    transport:
      sub.transport === "websocket"
        ? { method: "websocket", session_id: sub.websocketSessionId ?? undefined }
        : { method: "webhook", callback: sub.callbackUrl ?? undefined },
    created_at: sub.createdAt.toISOString(),
  });
}

/** Events that never pass through the outbox (chat publishes them to BUS.events directly), so webhooks cannot carry them. */
export const WEBSOCKET_ONLY_EVENT_TYPES: readonly PublicEventType[] = ["channel.chat.message"];
export const transportsFor = (type: PublicEventType): (typeof EVENT_TRANSPORTS)[number][] =>
  WEBSOCKET_ONLY_EVENT_TYPES.includes(type) ? ["websocket"] : ["webhook", "websocket"];

/** The user whose grant must back a scoped subscription (ADR 0027 §1, E9-subs brief). */
export function backingUserOf(type: EventType, condition: Record<string, string>): string | undefined {
  switch (bindingFor(EVENTS[type].scopes)) {
    case "none":
      return undefined;
    case "self":
      return condition.user_id;
    case "broadcaster_or_moderator":
      return condition.moderator_user_id ?? broadcasterOf(condition);
    case "broadcaster":
      return broadcasterOf(condition);
  }
}

export const EVENTSUB_WS_PATH = "/eventsub/ws";
/** `?keepalive_timeout_seconds=` on connect (ADR 0027 §3). */
export const EVENTSUB_WS_KEEPALIVE = { defaultSeconds: 10, minSeconds: 10, maxSeconds: 600 } as const;
/** Close codes: Twitch's 4000-4007, plus 4008 for a revoked authorization (policy). */
export const EVENTSUB_WS_CLOSE = {
  internalError: 4000,
  clientSentTraffic: 4001,
  pingPongFailed: 4002,
  connectionUnused: 4003,
  reconnectGraceExpired: 4004,
  networkTimeout: 4005,
  networkError: 4006,
  invalidReconnect: 4007,
  authorizationRevoked: 4008,
} as const;
