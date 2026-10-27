// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * REST chat as a chat client. `chat.send`, `chat.deleteMessage` and `chat.clear` do not repeat a
 * single chat rule: they open one WebSocket to the chat service as the caller (a short-lived chat
 * token with the caller's scopes and app), join the channel, send one frame and wait for its
 * answer. Every rule (bans, modes, rate limits, filters, rank checks) and every side effect
 * (rows, audit, events, fan-out) stays in services/chat.
 *
 * The socket is per call and always closed. Never log the token (it is in the URL) or the body.
 */
import { ORPCError } from "@orpc/server";
import { CHAT_LIMITS, ServerFrame, type ClientFrame, type NoticeCode } from "@commonair/contracts/chat";
import { apiError, notFound } from "../lib/errors.ts";

/** The REST call waits at most this long for chat's answer. */
export const RELAY_TIMEOUT_MS = 5_000;

const JOIN_NONCE = "rest-join";
const REQUEST_NONCE = "rest-req";

export interface RelaySocket {
  send(data: string): void;
  close(): void;
}

export interface RelaySocketHandlers {
  open(): void;
  message(data: string): void;
  /** Closed or failed (an `error` is always followed by `close`; either ends the call). */
  close(): void;
}

export type RelaySocketFactory = (url: string, handlers: RelaySocketHandlers) => RelaySocket;

/** What the REST call asks chat to do. Commands are the ones `services/chat/src/commands.ts` parses. */
export type RelayRequest =
  | { op: "send"; channel: string; body: string; replyToId?: string | undefined }
  | { op: "command"; channel: string; command: "delete" | "clear"; args: string[] };

export type RelayOutcome =
  /** `send` accepted (held or not). */
  | { type: "ack"; id: string; held: boolean }
  /** A notice answering the request: a refusal for `send`, the result (`cmd_success` or not) for a command. */
  | { type: "notice"; code: NoticeCode; text: string }
  /** An `error` frame for the join or the request (`channel_not_found`, `rate_limited`, …). */
  | { type: "error"; code: string }
  | { type: "timeout" }
  /** The socket closed (or never opened) before an answer: unreachable, or the upgrade was refused. */
  | { type: "closed" };

export const bunSocket: RelaySocketFactory = (url, h) => {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => h.open());
  ws.addEventListener("message", (ev: MessageEvent) => {
    h.message(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
  });
  ws.addEventListener("close", () => h.close());
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    },
  };
};

export interface RelayOptions {
  /** CHAT_INTERNAL_URL (ws://…/ws). */
  url: string;
  token: string;
  request: RelayRequest;
  timeoutMs?: number;
  socket?: RelaySocketFactory;
}

function requestFrame(r: RelayRequest): ClientFrame {
  if (r.op === "send")
    return {
      op: "send",
      channel: r.channel,
      body: r.body,
      isAction: false,
      nonce: REQUEST_NONCE,
      ...(r.replyToId ? { replyToId: r.replyToId } : {}),
    };
  return { op: "command", channel: r.channel, command: r.command, args: r.args, nonce: REQUEST_NONCE };
}

/**
 * Decide the outcome from one server frame, or null to keep waiting. Exported for tests.
 * `send` is answered by optional notices then exactly one ack; a refusal is a notice followed by
 * an ack with a null id, so the notice decides. `msg_held` is informational (the ack follows).
 * A command is answered by exactly one notice.
 */
export function outcomeOf(request: RelayRequest, frame: ServerFrame): RelayOutcome | null {
  switch (frame.op) {
    case "error":
      return frame.nonce === JOIN_NONCE || frame.nonce === REQUEST_NONCE ? { type: "error", code: frame.code } : null;
    case "notice":
      if (frame.nonce !== REQUEST_NONCE) return null;
      if (request.op === "send" && frame.code === "msg_held") return null;
      return { type: "notice", code: frame.code, text: frame.text };
    case "ack":
      if (frame.nonce !== REQUEST_NONCE || request.op !== "send") return null;
      // An ack without an id always follows the notice that explains it; this is a fallback.
      return frame.id
        ? { type: "ack", id: frame.id, held: frame.held }
        : { type: "notice", code: "msg_rejected", text: "" };
    default:
      return null;
  }
}

/** Open, join, send one frame, wait for its answer, close. Never throws. */
export function relayToChat(opts: RelayOptions): Promise<RelayOutcome> {
  const make = opts.socket ?? bunSocket;
  const url = new URL(opts.url);
  url.searchParams.set("token", opts.token);
  return new Promise<RelayOutcome>((resolve) => {
    let socket: RelaySocket | null = null;
    let done = false;
    const finish = (o: RelayOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // already closed
      }
      resolve(o);
    };
    const timer = setTimeout(() => finish({ type: "timeout" }), opts.timeoutMs ?? RELAY_TIMEOUT_MS);
    try {
      socket = make(url.toString(), {
        open: () => {
          // Chat handles a socket's frames in order, so the request may follow the join at once.
          socket?.send(JSON.stringify({ op: "join", channel: opts.request.channel, nonce: JOIN_NONCE }));
          socket?.send(JSON.stringify(requestFrame(opts.request)));
        },
        message: (data) => {
          let json: unknown;
          try {
            json = JSON.parse(data);
          } catch {
            return;
          }
          const parsed = ServerFrame.safeParse(json);
          if (!parsed.success) return;
          const o = outcomeOf(opts.request, parsed.data);
          if (o) finish(o);
        },
        close: () => finish({ type: "closed" }),
      });
      if (done) socket.close();
    } catch {
      finish({ type: "closed" });
    }
  });
}

const RATE_LIMITED = new Set<NoticeCode>(["msg_slowmode", "msg_ratelimit"]);
const FORBIDDEN = new Set<NoticeCode>([
  "msg_banned",
  "msg_timedout",
  "msg_followersonly",
  "msg_subsonly",
  "msg_account_too_new",
  "msg_verified_email",
  "msg_channel_suspended",
  "msg_requires_login",
  "no_permission",
]);

/** Seconds a rate-limit notice tells the sender to wait ("… in 12 seconds"), else the chat window. */
export function retryAfterOf(text: string): number {
  const m = /(\d+)\s*seconds?/i.exec(text);
  const n = m?.[1] ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : Math.ceil(CHAT_LIMITS.windowMs / 1000);
}

export const unavailable = (why = "Chat is unavailable. Try again.") =>
  new ORPCError("SERVICE_UNAVAILABLE", { status: 503, message: why });

/**
 * The API error for a refusal. The notice code is in the message (clients branch on it); chat's
 * English text is not, since it can quote what the caller sent.
 */
export function noticeError(code: NoticeCode, text: string): ORPCError<string, unknown> {
  const message = `Chat refused the request (${code})`;
  if (RATE_LIMITED.has(code)) return apiError("RATE_LIMITED", message, { retryAfterSeconds: retryAfterOf(text) });
  if (FORBIDDEN.has(code)) return apiError("FORBIDDEN", message);
  return apiError("BAD_REQUEST", message);
}

/** The API error for an outcome that is not a success. */
export function outcomeError(o: Exclude<RelayOutcome, { type: "ack" }>): ORPCError<string, unknown> {
  switch (o.type) {
    case "notice":
      return noticeError(o.code, o.text);
    case "error":
      if (o.code === "channel_not_found") return notFound("Channel not found");
      if (o.code === "rate_limited")
        return apiError("RATE_LIMITED", `Chat refused the request (${o.code})`, {
          retryAfterSeconds: 1,
        });
      return unavailable();
    case "timeout":
      return unavailable("Chat did not answer in time. Try again.");
    case "closed":
      return unavailable();
  }
}
