// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The upstream chat WebSocket: one per IRC client, authenticated with the
 * client's OAuth token as `Authorization: Bearer` (none for anonymous viewers).
 */
import { ServerFrame, type ClientFrame } from "@commonair/contracts";
import type { Logger } from "@commonair/observability";

export type UpstreamCloseKind =
  /** The handshake was answered with a non-101 status (bad or revoked token, or no access). */
  | "rejected"
  /** The chat service could not be reached. */
  | "unreachable"
  /** An established connection closed. */
  | "closed";

/**
 * CONTRACT-REQUEST: add `nonce: z.string().max(64).optional()` to the `notice` ServerFrame in
 * packages/contracts/src/chat.ts (echo of the request's nonce). Until it is in the schema, Zod
 * strips it, so it is read from the raw JSON here.
 */
export type UpstreamFrame =
  | Exclude<ServerFrame, { op: "notice" }>
  | (Extract<ServerFrame, { op: "notice" }> & { nonce?: string | undefined });

export function withNoticeNonce(frame: ServerFrame, raw: unknown): UpstreamFrame {
  if (frame.op !== "notice") return frame;
  const nonce = (raw as { nonce?: unknown } | null)?.nonce;
  return typeof nonce === "string" && nonce.length <= 64 ? { ...frame, nonce } : frame;
}

export interface UpstreamHandlers {
  open(): void;
  frame(frame: UpstreamFrame): void;
  close(kind: UpstreamCloseKind, reason: string): void;
}

export interface Upstream {
  send(frame: ClientFrame): void;
  close(): void;
}

export type UpstreamFactory = (token: string | null, handlers: UpstreamHandlers) => Upstream;

export function websocketUpstream(url: string, logger: Logger): UpstreamFactory {
  return (token, handlers) => {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const ws = new WebSocket(url, { headers });
    let opened = false;
    let closed = false;

    ws.addEventListener("open", () => {
      opened = true;
      handlers.open();
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        logger.warn("upstream sent invalid JSON");
        return;
      }
      const parsed = ServerFrame.safeParse(json);
      if (!parsed.success) {
        logger.warn("upstream sent an unknown frame", { op: (json as { op?: unknown } | null)?.op });
        return;
      }
      handlers.frame(withNoticeNonce(parsed.data, json));
    });
    ws.addEventListener("close", (ev: CloseEvent) => {
      if (closed) return;
      closed = true;
      const kind: UpstreamCloseKind = opened ? "closed" : ev.code === 1002 ? "rejected" : "unreachable";
      handlers.close(kind, ev.reason);
    });

    return {
      send(frame) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      },
      close() {
        closed = true;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
      },
    };
  };
}
