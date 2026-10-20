// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The event catalog. Modeled on Twitch EventSub (type names, snake_case payload
 * fields, the webhook/WebSocket envelopes and the HMAC signature scheme) so bots
 * port over with minimal changes. Events are produced via the outbox (`events`
 * table) and delivered to webhooks, the EventSub WebSocket, overlays and bots.
 */
import { z } from "zod";
import type { Scope } from "./scopes.ts";
import {
  HASH_LIST_CATEGORIES,
  LEGAL_HOLD_REASONS,
  MODERATION_CASE_ORIGINS,
  MODERATION_CASE_STATUSES,
  MODERATION_CATEGORIES,
  MODERATION_SUBJECTS,
  MODERATION_TIERS,
} from "./enums.ts";

const id = z.string();
const ts = z.string();
const broadcaster = {
  broadcaster_user_id: id,
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
};
const user = { user_id: id, user_login: z.string(), user_name: z.string() };
const moderator = {
  moderator_user_id: id,
  moderator_user_login: z.string(),
  moderator_user_name: z.string(),
};
const choice = z.object({ id: z.string(), title: z.string(), votes: z.number().int() });
const outcome = z.object({
  id: z.string(),
  title: z.string(),
  users: z.number().int(),
  channel_points: z.number().int(),
});

interface EventDef {
  version: string;
  condition: readonly string[];
  scopes: readonly Scope[];
  description: string;
  payload: z.ZodObject;
  /**
   * Internal events (trust & safety) live in the outbox for audit and service fan-out only:
   * they are never offered to apps (`PUBLIC_EVENT_TYPES`), never fanned out to webhooks or
   * the EventSub WebSocket, and never published on `BUS.events`. Payloads carry ids and enums.
   */
  internal?: true;
}
const def = <P extends z.ZodRawShape, I extends true | undefined = undefined>(
  d: Omit<EventDef, "payload" | "internal"> & { payload: P; internal?: I },
) => ({
  ...d,
  internal: d.internal as I,
  payload: z.object(d.payload),
});

export const EVENTS = {
  "stream.online": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "A broadcast started",
    payload: { ...broadcaster, id, type: z.literal("live"), started_at: ts },
  }),
  "stream.offline": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "A broadcast ended",
    payload: { ...broadcaster },
  }),
  "channel.update": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "Title, category, language, tags or mature label changed",
    payload: {
      ...broadcaster,
      title: z.string(),
      language: z.string(),
      category_id: id.nullable(),
      category_name: z.string().nullable(),
      tags: z.array(z.string()),
      mature: z.boolean(),
    },
  }),
  "channel.follow": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "A user followed (integrity-excluded follows are not emitted)",
    payload: { ...broadcaster, ...user, followed_at: ts },
  }),
  "channel.subscribe": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:read:subscriptions"],
    description: "A subscription started",
    payload: {
      ...broadcaster,
      ...user,
      tier: z.enum(["1000", "2000", "3000"]),
      is_gift: z.boolean(),
    },
  }),
  "channel.subscription.end": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:read:subscriptions"],
    description: "A subscription ended",
    payload: {
      ...broadcaster,
      ...user,
      tier: z.enum(["1000", "2000", "3000"]),
      is_gift: z.boolean(),
    },
  }),
  "channel.subscription.gift": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:read:subscriptions"],
    description: "Subscriptions were gifted",
    payload: {
      ...broadcaster,
      user_id: id.nullable(),
      user_login: z.string().nullable(),
      user_name: z.string().nullable(),
      total: z.number().int(),
      tier: z.enum(["1000", "2000", "3000"]),
      is_anonymous: z.boolean(),
    },
  }),
  "channel.tip": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:read:tips"],
    description: "A tip succeeded",
    payload: {
      ...broadcaster,
      user_id: id.nullable(),
      user_login: z.string().nullable(),
      user_name: z.string().nullable(),
      is_anonymous: z.boolean(),
      amount: z.object({
        value: z.number().int(),
        /** The currency's minor units (`minorUnits(currency)`): 2 for usd, 0 for jpy. */
        decimal_places: z.number().int().min(0).max(4),
        currency: z.string(),
      }),
      message: z.string(),
    },
  }),
  "channel.raid": def({
    version: "1",
    condition: ["to_broadcaster_user_id"],
    scopes: [],
    description: "A raid arrived (viewers are integrity-verified)",
    payload: {
      from_broadcaster_user_id: id,
      from_broadcaster_user_login: z.string(),
      from_broadcaster_user_name: z.string(),
      to_broadcaster_user_id: id,
      to_broadcaster_user_login: z.string(),
      to_broadcaster_user_name: z.string(),
      viewers: z.number().int(),
    },
  }),
  "channel.chat.message": def({
    version: "1",
    condition: ["broadcaster_user_id", "user_id"],
    scopes: ["chat:read"],
    description: "A chat message was sent",
    payload: {
      ...broadcaster,
      chatter_user_id: id,
      chatter_user_login: z.string(),
      chatter_user_name: z.string(),
      message_id: id,
      message: z.object({
        text: z.string(),
        fragments: z.array(
          z.object({
            type: z.enum(["text", "emote", "mention"]),
            text: z.string(),
            emote: z.object({ id }).nullable(),
          }),
        ),
      }),
      badges: z.array(z.object({ set_id: z.string(), id: z.string() })),
      color: z.string(),
      reply: z
        .object({
          parent_message_id: id,
          parent_user_login: z.string(),
          parent_message_body: z.string(),
        })
        .nullable(),
      is_bot: z.boolean(),
    },
  }),
  "channel.chat.message_delete": def({
    version: "1",
    condition: ["broadcaster_user_id", "user_id"],
    scopes: ["chat:read"],
    description: "A message was deleted by a moderator",
    payload: {
      ...broadcaster,
      target_user_id: id,
      target_user_login: z.string(),
      target_user_name: z.string(),
      message_id: id,
    },
  }),
  "channel.chat.clear": def({
    version: "1",
    condition: ["broadcaster_user_id", "user_id"],
    scopes: ["chat:read"],
    description: "Chat was cleared",
    payload: { ...broadcaster },
  }),
  "channel.chat_settings.update": def({
    version: "1",
    condition: ["broadcaster_user_id", "user_id"],
    scopes: ["chat:read"],
    description: "Chat modes changed",
    payload: {
      ...broadcaster,
      emote_mode: z.boolean(),
      follower_mode: z.boolean(),
      follower_mode_duration_minutes: z.number().int().nullable(),
      slow_mode: z.boolean(),
      slow_mode_wait_time_seconds: z.number().int().nullable(),
      subscriber_mode: z.boolean(),
    },
  }),
  "channel.ban": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["moderator:manage:chat"],
    description: "A user was banned or timed out",
    payload: {
      ...broadcaster,
      ...user,
      ...moderator,
      reason: z.string(),
      banned_at: ts,
      ends_at: ts.nullable(),
      is_permanent: z.boolean(),
    },
  }),
  "channel.unban": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["moderator:manage:chat"],
    description: "A ban or timeout was lifted",
    payload: { ...broadcaster, ...user, ...moderator },
  }),
  "channel.moderator.add": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["moderator:manage:chat"],
    description: "A moderator was added",
    payload: { ...broadcaster, ...user },
  }),
  "channel.moderator.remove": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["moderator:manage:chat"],
    description: "A moderator was removed",
    payload: { ...broadcaster, ...user },
  }),
  "channel.poll.begin": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:polls"],
    description: "A poll started",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      choices: z.array(choice),
      started_at: ts,
      ends_at: ts,
    },
  }),
  "channel.poll.progress": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:polls"],
    description: "Poll votes changed",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      choices: z.array(choice),
      started_at: ts,
      ends_at: ts,
    },
  }),
  "channel.poll.end": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:polls"],
    description: "A poll ended",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      choices: z.array(choice),
      status: z.enum(["completed", "terminated", "archived"]),
      started_at: ts,
      ended_at: ts,
    },
  }),
  "channel.prediction.begin": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:predictions"],
    description: "A prediction started",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      outcomes: z.array(outcome),
      started_at: ts,
      locks_at: ts,
    },
  }),
  "channel.prediction.progress": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:predictions"],
    description: "Prediction bets changed",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      outcomes: z.array(outcome),
      started_at: ts,
      locks_at: ts,
    },
  }),
  "channel.prediction.lock": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:predictions"],
    description: "Betting locked",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      outcomes: z.array(outcome),
      started_at: ts,
      locked_at: ts,
    },
  }),
  "channel.prediction.end": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:manage:predictions"],
    description: "A prediction resolved or was canceled",
    payload: {
      ...broadcaster,
      id,
      title: z.string(),
      outcomes: z.array(outcome),
      winning_outcome_id: z.string().nullable(),
      status: z.enum(["resolved", "canceled"]),
      started_at: ts,
      ended_at: ts,
    },
  }),
  "channel.goal.begin": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "A goal started",
    payload: {
      ...broadcaster,
      id,
      type: z.enum(["followers", "subscriptions", "tips"]),
      description: z.string(),
      current_amount: z.number().int(),
      target_amount: z.number().int(),
      started_at: ts,
    },
  }),
  "channel.goal.progress": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "Goal progress changed",
    payload: {
      ...broadcaster,
      id,
      type: z.enum(["followers", "subscriptions", "tips"]),
      description: z.string(),
      current_amount: z.number().int(),
      target_amount: z.number().int(),
      started_at: ts,
    },
  }),
  "channel.goal.end": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: [],
    description: "A goal ended",
    payload: {
      ...broadcaster,
      id,
      type: z.enum(["followers", "subscriptions", "tips"]),
      description: z.string(),
      current_amount: z.number().int(),
      target_amount: z.number().int(),
      is_achieved: z.boolean(),
      started_at: ts,
      ended_at: ts,
    },
  }),
  "channel.points.change": def({
    version: "1",
    condition: ["broadcaster_user_id"],
    scopes: ["channel:read:points"],
    description: "A user's loyalty points changed by an action (not by passive accrual)",
    payload: {
      ...broadcaster,
      ...user,
      delta: z.number().int(),
      balance: z.number().int(),
      reason: z.string(),
    },
  }),
  "coop.proposal.update": def({
    version: "1",
    condition: [],
    scopes: [],
    description: "A governance proposal changed status",
    payload: {
      proposal_id: id,
      title: z.string(),
      status: z.string(),
      kind: z.enum(["ordinary", "protected"]),
      passed: z.boolean().nullable(),
      reason: z.string().nullable(),
    },
  }),
  // Internal (trust & safety, ADR 0006). Ids and enums only: never frames, URLs, keys or PII.
  "moderation.flagged": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: a moderation signal crossed a threshold and a flag was recorded",
    payload: {
      case_id: id,
      flag_id: id,
      tier: z.enum(MODERATION_TIERS),
      origin: z.enum(MODERATION_CASE_ORIGINS),
      subject_type: z.enum(MODERATION_SUBJECTS),
      subject_id: id,
      channel_id: id.nullable(),
      category: z.enum(MODERATION_CATEGORIES).nullable(),
      list_category: z.enum(HASH_LIST_CATEGORIES).nullable(),
      provider: z.string(),
      provider_version: z.string(),
    },
  }),
  "moderation.case.resolved": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: a moderation case reached a decision",
    payload: {
      case_id: id,
      tier: z.enum(MODERATION_TIERS),
      status: z.enum(MODERATION_CASE_STATUSES),
      resolution: z.string(),
      actor_type: z.enum(["system", "moderator", "legal"]),
    },
  }),
  "moderation.restriction": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: a live broadcast was restricted (T1) or the restriction was lifted",
    payload: { broadcast_id: id, channel_id: id, case_id: id, restricted: z.boolean() },
  }),
  "ncii.request.received": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: an NCII takedown request arrived (the 48-hour clock started)",
    payload: { request_id: id, deadline_at: ts, items: z.number().int(), resolved_items: z.number().int() },
  }),
  "ncii.request.decided": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: an NCII request was decided, or auto-hidden at its deadline",
    payload: { request_id: id, decision: z.enum(["removed", "rejected", "auto_hidden"]) },
  }),
  "legal.hold.placed": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: a legal hold was placed on a user's data",
    payload: { hold_id: id, user_id: id, reason_code: z.enum(LEGAL_HOLD_REASONS), case_id: id.nullable() },
  }),
  "ncmec.draft.created": def({
    version: "1",
    condition: [],
    scopes: [],
    internal: true,
    description: "Internal: an NCMEC CyberTipline report draft awaits filing by the legal role",
    payload: { report_id: id, case_id: id, hold_id: id },
  }),
} as const;

export type EventType = keyof typeof EVENTS;
export const EVENT_TYPES = Object.keys(EVENTS) as [EventType, ...EventType[]];
export type EventPayload<T extends EventType> = z.infer<(typeof EVENTS)[T]["payload"]>;
/** Internal event types (see `EventDef.internal`). */
export type InternalEventType = {
  [K in EventType]: (typeof EVENTS)[K] extends { internal: true } ? K : never;
}[EventType];
/** Event types apps may see and subscribe to. */
export type PublicEventType = Exclude<EventType, InternalEventType>;
export const isInternalEvent = (type: string): boolean =>
  Object.hasOwn(EVENTS, type) && (EVENTS[type as EventType] as EventDef).internal === true;
export const PUBLIC_EVENT_TYPES = EVENT_TYPES.filter((t) => !isInternalEvent(t)) as [
  PublicEventType,
  ...PublicEventType[],
];
export const INTERNAL_EVENT_TYPES = EVENT_TYPES.filter(isInternalEvent) as InternalEventType[];

/** Header names for signed webhooks (Twitch-style, vendor-neutral prefix). */
export const WEBHOOK_HEADERS = {
  messageId: "eventsub-message-id",
  messageRetry: "eventsub-message-retry",
  messageType: "eventsub-message-type",
  messageSignature: "eventsub-message-signature",
  messageTimestamp: "eventsub-message-timestamp",
  subscriptionType: "eventsub-subscription-type",
  subscriptionVersion: "eventsub-subscription-version",
} as const;
export const WEBHOOK_MESSAGE_TYPES = ["notification", "webhook_callback_verification", "revocation"] as const;

/**
 * Signature: "sha256=" + hex(HMAC-SHA256(secret, messageId + timestamp + rawBody)).
 * Receivers must reject messages older than 10 minutes and dedupe by message id.
 */
export async function signWebhook(secret: string, messageId: string, timestamp: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(messageId + timestamp + body)));
  return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyWebhook(
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  const age = now - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > 10 * 60_000) return false;
  const expected = await signWebhook(secret, messageId, timestamp, body);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export const SubscriptionEnvelope = z.object({
  id,
  type: z.enum(PUBLIC_EVENT_TYPES),
  version: z.string(),
  status: z.string(),
  condition: z.record(z.string(), z.string()),
  transport: z.object({
    method: z.enum(["webhook", "websocket"]),
    callback: z.string().optional(),
    session_id: z.string().optional(),
  }),
  created_at: ts,
});

/** WebSocket transport messages (EventSub WebSocket shape). */
export const WsMetadata = z.object({
  message_id: id,
  message_type: z.enum(["session_welcome", "session_keepalive", "notification", "session_reconnect", "revocation"]),
  message_timestamp: ts,
  subscription_type: z.enum(PUBLIC_EVENT_TYPES).optional(),
  subscription_version: z.string().optional(),
});
export const WsMessage = z.object({
  metadata: WsMetadata,
  payload: z.object({
    session: z
      .object({
        id: z.string(),
        status: z.string(),
        keepalive_timeout_seconds: z.number().int().nullable(),
        reconnect_url: z.string().nullable(),
        connected_at: ts,
      })
      .optional(),
    subscription: SubscriptionEnvelope.optional(),
    event: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type WsMessage = z.infer<typeof WsMessage>;

/** Valkey channels used by the event bus. */
export const BUS = {
  /** All events, published by the outbox relay: JSON {id,type,version,channelId,payload,occurredAt}. */
  events: "bus:events",
  /** Per-channel chat fan-out. */
  chat: (channelId: string) => `chat:${channelId}`,
  /** Per-channel moderation/control (bans, clears, settings) consumed by chat and IRC. */
  chatControl: (channelId: string) => `chat-control:${channelId}`,
  /** Live status changes (online/offline/transcode) for media and origin services. */
  live: "bus:live",
  /** Platform-wide per-user control (UserControlMessage): suspension, deletion, token revocation. */
  userControl: "bus:user-control",
} as const;

/** Only public events are published on `BUS.events`. */
export const BusEvent = z.object({
  id,
  type: z.enum(PUBLIC_EVENT_TYPES),
  version: z.string(),
  channelId: id.nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: ts,
});
export type BusEvent = z.infer<typeof BusEvent>;

/**
 * Published by the API on BUS.userControl when a user's standing or credentials change platform-wide.
 * Chat, IRC and the EventSub WebSocket drop caches (`invalidate`) or close the user's sockets
 * (`disconnect`, optionally only those authenticated with one token).
 */
export const UserControlMessage = z.object({
  op: z.enum(["invalidate", "disconnect"]),
  userId: id,
  /** sha256 of the revoked access token, when only sockets using that token must close. */
  tokenHash: z.string().optional(),
  reason: z.enum(["suspended", "deleted", "token_revoked", "role_changed", "profile_changed"]),
});
export type UserControlMessage = z.infer<typeof UserControlMessage>;
