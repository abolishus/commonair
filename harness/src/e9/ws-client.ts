// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A recording EventSub WebSocket client for the `developer-platform` scenario (ADR 0027 §3,
 * `EVENTSUB_WS_PATH`): every message, the next one of a type, and how the socket closed. Owned by
 * the orchestrator: units send a contract request instead of editing it.
 */
import { WsMessage } from "@commonair/contracts/events";

export type WsMessageType = WsMessage["metadata"]["message_type"];

export interface EventSubConnection {
  /** Every parsed message, in order. */
  readonly messages: readonly WsMessage[];
  /** The next message of `type` not returned before (past messages count), or a timeout error. */
  next(type: WsMessageType, timeoutMs?: number): Promise<WsMessage>;
  /** Resolves when the socket closes, with the server's code and reason. */
  readonly closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

const DEFAULT_WAIT_MS = 30_000;

/** Connect (resolves once open). `url` is `ws(s)://<api><EVENTSUB_WS_PATH>[?keepalive_timeout_seconds=]`. */
export async function openEventSub(url: string): Promise<EventSubConnection> {
  const ws = new WebSocket(url);
  const messages: WsMessage[] = [];
  const consumed = new Set<WsMessage>();
  const waiters = new Set<{ type: WsMessageType; resolve: (m: WsMessage) => void }>();

  ws.addEventListener("message", (ev) => {
    let parsed: WsMessage;
    try {
      const r = WsMessage.safeParse(JSON.parse(String(ev.data)));
      if (!r.success) return;
      parsed = r.data;
    } catch {
      return;
    }
    messages.push(parsed);
    for (const w of waiters)
      if (w.type === parsed.metadata.message_type) {
        waiters.delete(w);
        consumed.add(parsed);
        w.resolve(parsed);
        break;
      }
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }), { once: true }),
  );

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("eventsub websocket connection failed")), { once: true });
  });

  return {
    messages,
    closed,
    next(type, timeoutMs = DEFAULT_WAIT_MS) {
      const past = messages.find((m) => !consumed.has(m) && m.metadata.message_type === type);
      if (past) {
        consumed.add(past);
        return Promise.resolve(past);
      }
      return new Promise<WsMessage>((resolve, reject) => {
        const w = {
          type,
          resolve: (m: WsMessage) => {
            clearTimeout(timer);
            resolve(m);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`eventsub: no ${type} within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    close() {
      ws.close();
    },
  };
}
