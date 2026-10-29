// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The minimal chat surface a bot needs: connect, join, say, read messages. It speaks the chat
 * WebSocket protocol (`ClientFrame` / `ServerFrame` in the contract) and validates every frame.
 * Bots authenticate with `Authorization: Bearer <token>` on the upgrade (Bun and Node's WebSocket
 * accept headers); browsers cannot set headers, so they pass a chat token from `chat.connectToken`
 * as `chatToken` instead. Twitch IRC bots (tmi.js) can keep IRC: the instance runs a gateway.
 */
import { type ClientFrame, ServerFrame } from "@commonair/contracts/chat";
import type { CommonAirClient } from "./client.ts";

/** A WebSocket constructor; the second argument carries request headers where supported (Bun, Node). */
export type WebSocketConstructorLike = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;

export type ChatServerFrame = ServerFrame;
type FrameOf<Op extends ServerFrame["op"]> = Extract<ServerFrame, { op: Op }>;

/** A chat message as a bot sees it. */
export interface ChatMessageEvent {
  channel: string;
  id: string;
  userId: string;
  username: string;
  displayName: string;
  text: string;
  isAction: boolean;
  /** Held by a word filter (moderators only see these). */
  held: boolean;
  frame: FrameOf<"message">;
}

/** A refusal from the chat server (`error` frame), or a message it did not accept. */
export class ChatError extends Error {
  override readonly name = "ChatError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface ChatConnectOptions {
  /** The chat WebSocket URL. Defaults to the URL `client.chat.connectToken()` returns. */
  url?: string;
  /** Used to discover the URL (and, with `useChatToken`, a chat token). */
  client?: CommonAirClient;
  /** An OAuth access token (user or bot) with `chat:read` (and `chat:edit` to talk). */
  token?: string;
  /** Authenticate with this chat token as `?token=` instead of a bearer header (browsers). */
  chatToken?: string;
  /** Fetch a chat token with `client.chat.connectToken()` and use it as `?token=` (browsers). */
  useChatToken?: boolean;
  WebSocket?: WebSocketConstructorLike;
  /** Wait at most this long for `welcome` (default 10 000 ms). */
  connectTimeoutMs?: number;
  /** Wait at most this long for a `joined` or `ack` (default 10 000 ms). */
  replyTimeoutMs?: number;
  onError?: (error: Error) => void;
}

export interface ChatConnection {
  readonly welcome: FrameOf<"welcome">;
  readonly isOpen: boolean;
  join(channel: string): Promise<FrameOf<"joined">>;
  part(channel: string): Promise<void>;
  /** Send and wait for the ack; throws `ChatError` when the server refuses the message. */
  say(
    channel: string,
    text: string,
    opts?: { replyToId?: string; isAction?: boolean },
  ): Promise<{ id: string | null; held: boolean }>;
  onMessage(handler: (m: ChatMessageEvent) => void): () => void;
  /** Every validated frame. */
  onFrame(handler: (f: ServerFrame) => void): () => void;
  /** Resolves when the socket closes, with its code. */
  readonly closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

const OPEN = 1;

/** Connect and wait for `welcome`. Keeps the socket alive with pings at half the heartbeat. */
export async function connectChat(opts: ChatConnectOptions): Promise<ChatConnection> {
  let url = opts.url;
  let chatToken = opts.chatToken;
  if (!url || (opts.useChatToken && !chatToken)) {
    if (!opts.client) throw new Error("connectChat needs `url` or `client`");
    const t = await opts.client.chat.connectToken();
    url ??= t.url;
    if (opts.useChatToken) chatToken ??= t.token;
  }
  const u = new URL(url);
  if (chatToken) u.searchParams.set("token", chatToken);
  const Ws = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructorLike }).WebSocket;
  if (!Ws) throw new Error("no WebSocket implementation: pass `WebSocket`");
  // Bun and Node (undici) take request headers as a non-standard second argument.
  const ws =
    !chatToken && opts.token
      ? new Ws(u.toString(), { headers: { authorization: `Bearer ${opts.token}` } })
      : new Ws(u.toString());

  const listeners = new Set<(f: ServerFrame) => void>();
  const replyTimeoutMs = opts.replyTimeoutMs ?? 10_000;
  let nonce = 0;
  let ended = false;
  let pinger: ReturnType<typeof setInterval> | null = null;
  const report = (e: Error) => opts.onError?.(e);

  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) => {
      ended = true;
      if (pinger) clearInterval(pinger);
      resolve({ code: ev.code, reason: ev.reason });
    }),
  );

  ws.addEventListener("message", (ev) => {
    let json: unknown;
    try {
      json = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
    } catch {
      return report(new Error("chat: a frame was not JSON"));
    }
    const r = ServerFrame.safeParse(json);
    if (!r.success) return report(new Error("chat: a frame did not match the protocol"));
    for (const l of listeners) l(r.data);
  });
  ws.addEventListener("error", () => undefined);

  const onFrame = (l: (f: ServerFrame) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  /** The next frame of `op` matching `match`; an `error` frame for the same request rejects it. */
  const next = <Op extends ServerFrame["op"]>(
    op: Op,
    match: (f: FrameOf<Op>) => boolean,
    timeoutMs: number,
    failsOn: (f: FrameOf<"error">) => boolean = () => false,
  ) =>
    new Promise<FrameOf<Op>>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new ChatError("timeout", `no ${op} within ${timeoutMs} ms`));
      }, timeoutMs);
      const off = onFrame((f) => {
        if (f.op === "error" && failsOn(f)) {
          clearTimeout(timer);
          off();
          reject(new ChatError(f.code, f.message));
        } else if (f.op === op && match(f as FrameOf<Op>)) {
          clearTimeout(timer);
          off();
          resolve(f as FrameOf<Op>);
        }
      });
    });

  const welcomeP = next(
    "welcome",
    () => true,
    opts.connectTimeoutMs ?? 10_000,
    () => true,
  );
  welcomeP.catch(() => undefined);
  let welcome: FrameOf<"welcome">;
  try {
    welcome = await Promise.race([
      welcomeP,
      closed.then(({ code }) => Promise.reject(new ChatError("closed", `chat socket closed (${code}) before welcome`))),
    ]);
  } catch (err) {
    ws.close();
    throw err;
  }

  const raw = (frame: ClientFrame) => {
    if (ended || ws.readyState !== OPEN) throw new ChatError("closed", "chat connection is closed");
    ws.send(JSON.stringify(frame));
  };
  pinger = setInterval(
    () => {
      if (!ended && ws.readyState === OPEN) raw({ op: "ping" });
    },
    Math.max(1_000, Math.floor(welcome.heartbeatMs / 2)),
  );

  return {
    welcome,
    get isOpen() {
      return !ended && ws.readyState === OPEN;
    },
    async join(channel) {
      const n = `j${++nonce}`;
      const joined = next(
        "joined",
        (f) => f.channel === channel,
        replyTimeoutMs,
        (e) => e.nonce === n || e.channel === channel,
      );
      raw({ op: "join", channel, nonce: n });
      return joined;
    },
    async part(channel) {
      const n = `p${++nonce}`;
      const parted = next(
        "parted",
        (f) => f.channel === channel,
        replyTimeoutMs,
        (e) => e.nonce === n,
      );
      raw({ op: "part", channel, nonce: n });
      await parted;
    },
    async say(channel, text, o = {}) {
      const n = `s${++nonce}`;
      const ack = next(
        "ack",
        (f) => f.nonce === n,
        replyTimeoutMs,
        (e) => e.nonce === n,
      );
      raw({ op: "send", channel, body: text, nonce: n, isAction: o.isAction ?? false, replyToId: o.replyToId });
      const a = await ack;
      if (a.id === null && !a.held) throw new ChatError("rejected", "the message was not accepted");
      return { id: a.id, held: a.held };
    },
    onMessage(handler) {
      return onFrame((f) => {
        if (f.op !== "message") return;
        handler({
          channel: f.channel,
          id: f.message.id,
          userId: f.message.user.id,
          username: f.message.user.username,
          displayName: f.message.user.displayName,
          text: f.message.body,
          isAction: f.message.isAction,
          held: f.held ?? false,
          frame: f,
        });
      });
    },
    onFrame,
    closed,
    close() {
      if (pinger) clearInterval(pinger);
      if (!ended) ws.close(1000, "bye");
      ended = true;
    },
  };
}
