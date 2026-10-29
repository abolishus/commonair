// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure parts of the EventSub WebSocket transport (ADR 0027 §3): connect parameters, the messages
 * the server sends (`WsMessage` shapes), close codes and reasons, the reconnect URL, the
 * backpressure policy and how a `UserControlMessage` applies to a session. No I/O here.
 */
import {
  EVENTSUB_WS_CLOSE,
  EVENTSUB_WS_KEEPALIVE,
  EVENTSUB_WS_PATH,
  ENVELOPE_STATUS,
} from "@commonair/contracts/eventsub";
import type { PublicEventType, UserControlMessage, WsMessage } from "@commonair/contracts/events";
import { userControlTargets } from "@commonair/contracts/events";
import type { SubscriptionEnvelope } from "@commonair/contracts/events";
import type { z } from "zod";

type Envelope = z.infer<typeof SubscriptionEnvelope>;

export interface KeepaliveBounds {
  defaultSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

/**
 * `?keepalive_timeout_seconds=`: absent → the default; an integer within the bounds → itself;
 * anything else → null (the upgrade answers 400). Tests lower `minSeconds`.
 */
export function parseKeepalive(raw: string | null, bounds: KeepaliveBounds = EVENTSUB_WS_KEEPALIVE): number | null {
  if (raw === null) return bounds.defaultSeconds;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= bounds.minSeconds && n <= bounds.maxSeconds ? n : null;
}

export type CloseCode = (typeof EVENTSUB_WS_CLOSE)[keyof typeof EVENTSUB_WS_CLOSE];

/** Twitch's reason strings for its close codes, plus ours for 4008. */
export const CLOSE_REASONS: Record<CloseCode, string> = {
  4000: "internal server error",
  4001: "client sent inbound traffic",
  4002: "client failed ping-pong",
  4003: "connection unused",
  4004: "reconnect grace time expired",
  4005: "network timeout",
  4006: "network error",
  4007: "invalid reconnect",
  4008: "authorization revoked",
};

export const closeReason = (code: CloseCode): string => CLOSE_REASONS[code];

/** Normal closes that are not one of the EventSub codes. */
export const CLOSE_MOVED = { code: 1000, reason: "session moved" } as const;
export const CLOSE_GOING_AWAY = { code: 1001, reason: "server stopping" } as const;

/** `wss://` origin of the public URL (`ws://` for `http:`), then the path and the one-time resume token. */
export function reconnectUrl(publicUrl: string, resumeToken: string): string {
  const u = new URL(publicUrl);
  const scheme = u.protocol === "http:" ? "ws:" : "wss:";
  return `${scheme}//${u.host}${EVENTSUB_WS_PATH}?resume=${encodeURIComponent(resumeToken)}`;
}

/**
 * Backpressure: never queue unboundedly for a slow client. Before a send, a socket already over
 * the cap is closed (4000); after it, Bun's status says whether the frame was written (`> 0`),
 * queued under backpressure (`-1`, fine while under the cap) or dropped (`0`, the socket is gone or
 * broken: close it).
 */
export function beforeSend(bufferedBytes: number, capBytes: number): "send" | "close" {
  return bufferedBytes > capBytes ? "close" : "send";
}
export function afterSend(status: number): "sent" | "queued" | "dropped" {
  if (status > 0) return "sent";
  return status === -1 ? "queued" : "dropped";
}

/** A session's binding as `userControlTargets` reads it (`appId` null for personal tokens). */
export interface SessionBinding {
  appId: string | null;
  userId: string;
  tokenHash: string;
}

/**
 * What a `BUS.userControl` message does to one session: `close` (revocation, 4008), `invalidate`
 * (drop cached authorizations only) or nothing. Unbound sessions are never targeted. A
 * `token_rotated` disconnect only invalidates: the session is bound to the grant, which lives on.
 */
export function controlAction(
  binding: SessionBinding | null,
  msg: Pick<UserControlMessage, "op" | "userId" | "appId" | "tokenHash" | "reason">,
): "close" | "invalidate" | "none" {
  if (!binding || !userControlTargets(binding, msg)) return "none";
  if (msg.op === "disconnect" && msg.reason !== "token_rotated") return "close";
  return "invalidate";
}

export interface WelcomeArgs {
  messageId: string;
  now: Date;
  sessionId: string;
  keepaliveSeconds: number;
  connectedAt: Date;
}

export function welcomeMessage(a: WelcomeArgs): WsMessage {
  return {
    metadata: { message_id: a.messageId, message_type: "session_welcome", message_timestamp: a.now.toISOString() },
    payload: {
      session: {
        id: a.sessionId,
        status: "connected",
        keepalive_timeout_seconds: a.keepaliveSeconds,
        reconnect_url: null,
        connected_at: a.connectedAt.toISOString(),
      },
    },
  };
}

export function keepaliveMessage(messageId: string, now: Date): WsMessage {
  return {
    metadata: { message_id: messageId, message_type: "session_keepalive", message_timestamp: now.toISOString() },
    payload: {},
  };
}

export function reconnectMessage(a: {
  messageId: string;
  now: Date;
  sessionId: string;
  connectedAt: Date;
  reconnectUrl: string;
}): WsMessage {
  return {
    metadata: { message_id: a.messageId, message_type: "session_reconnect", message_timestamp: a.now.toISOString() },
    payload: {
      session: {
        id: a.sessionId,
        status: "reconnecting",
        keepalive_timeout_seconds: null,
        reconnect_url: a.reconnectUrl,
        connected_at: a.connectedAt.toISOString(),
      },
    },
  };
}

export function notificationMessage(a: {
  messageId: string;
  now: Date;
  subscription: Envelope;
  event: Record<string, unknown>;
}): WsMessage {
  return {
    metadata: {
      message_id: a.messageId,
      message_type: "notification",
      message_timestamp: a.now.toISOString(),
      subscription_type: a.subscription.type as PublicEventType,
      subscription_version: a.subscription.version,
    },
    payload: { subscription: a.subscription, event: a.event },
  };
}

/** `subscription.status` is `authorization_revoked` (the envelope builder takes the status). */
export const REVOKED_STATUS = ENVELOPE_STATUS.revoked;

export function revocationMessage(a: { messageId: string; now: Date; subscription: Envelope }): WsMessage {
  return {
    metadata: {
      message_id: a.messageId,
      message_type: "revocation",
      message_timestamp: a.now.toISOString(),
      subscription_type: a.subscription.type as PublicEventType,
      subscription_version: a.subscription.version,
    },
    payload: { subscription: a.subscription },
  };
}
