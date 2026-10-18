// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Per-socket state and the one place frames are written, so backpressure is enforced everywhere. */
import type { ServerWebSocket } from "bun";
import type { NoticeCode, ServerFrame } from "@commonair/contracts";
import type { Metrics } from "./metrics.ts";
import type { Identity } from "./types.ts";

export interface ConnData {
  sessionId: string;
  identity: Identity;
  /** The welcome frame's user, resolved before the upgrade. */
  user: { id: string; username: string; displayName: string } | null;
  /** slug → channelId of joined rooms. */
  rooms: Map<string, string>;
  lastSeen: number;
  closed: boolean;
  /** Token bucket for join/part/command frames (not chat sends, which have their own limits). */
  bucket: { tokens: number; updated: number };
  /** Serializes this socket's frame handling so a client sees replies in request order. */
  queue: Promise<void>;
  /** Frames queued but not yet handled; bounded so a flooding client cannot grow memory. */
  pending: number;
  /** Malformed frames received; too many closes the socket. */
  errors: number;
}

export type ChatSocket = ServerWebSocket<ConnData>;

export const CLOSE = {
  idle: 4000,
  /** Token expired or revoked; reconnect with fresh credentials. */
  credentials: 4001,
  tooManyErrors: 4009,
  restart: 1012,
} as const;

export interface Writer {
  /** Bytes above which a socket is considered a slow consumer and terminated. */
  maxBufferedBytes: number;
  metrics: Metrics;
}

/** Send a pre-serialized frame. Slow consumers are cut off instead of buffering unboundedly. */
export function sendRaw(ws: ChatSocket, data: string, w: Writer): boolean {
  if (ws.data.closed) return false;
  if (ws.getBufferedAmount() > w.maxBufferedBytes) {
    w.metrics.dropped("slow_consumer");
    ws.data.closed = true;
    ws.terminate();
    return false;
  }
  const status = ws.send(data);
  if (status === 0) {
    w.metrics.dropped("send_failed");
    return false;
  }
  w.metrics.framesOut(1);
  return true;
}

export const sendFrame = (ws: ChatSocket, frame: ServerFrame, w: Writer): boolean =>
  sendRaw(ws, JSON.stringify(frame), w);

/**
 * A notice, echoing the nonce of the frame it answers.
 * CONTRACT-REQUEST: add `nonce: z.string().optional()` to the `notice` ServerFrame (it is on
 * `error` and `ack` already); until then the field is written outside the typed frame.
 */
export function sendNotice(
  ws: ChatSocket,
  n: { channel: string | null; code: NoticeCode; text: string; nonce?: string | undefined },
  w: Writer,
): boolean {
  const frame: Extract<ServerFrame, { op: "notice" }> = {
    op: "notice",
    channel: n.channel,
    code: n.code,
    text: n.text,
  };
  return sendRaw(ws, JSON.stringify(n.nonce ? { ...frame, nonce: n.nonce } : frame), w);
}

/** Refill-on-read token bucket; returns false when the socket is over its control-frame budget. */
export function takeToken(data: ConnData, now: number, capacity = 20, perSecond = 2): boolean {
  const b = data.bucket;
  b.tokens = Math.min(capacity, b.tokens + ((now - b.updated) / 1000) * perSecond);
  b.updated = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
