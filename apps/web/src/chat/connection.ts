// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser chat client for one channel over the chat WebSocket (`ClientFrame`/`ServerFrame` from
 * @commonair/contracts/chat). Each (re)connect fetches a fresh short-lived `chat.connectToken`
 * (read-only when signed out), joins the channel after `welcome`, and pings at half the server's
 * heartbeat. Unexpected closes reconnect with exponential backoff. Socket, token source and
 * timers are injected so the protocol handling is unit-testable.
 */
import { ServerFrame, type ClientFrame } from "@commonair/contracts/chat";
import { backoffDelay } from "./backoff.ts";

export type ChatStatus = "connecting" | "open" | "closed";
export type ChatMessageFrame = Extract<ServerFrame, { op: "message" }>["message"];

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error" | "message", fn: (ev: { data?: unknown }) => void): void;
}

export interface ChatDeps {
  getToken: () => Promise<{ token: string; url: string }>;
  createSocket: (url: string) => SocketLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

export interface ChatEvents {
  onStatus: (status: ChatStatus) => void;
  onJoined: (me: { canChat: boolean; canModerate: boolean }) => void;
  onMessage: (message: ChatMessageFrame) => void;
  onDelete: (messageId: string) => void;
  onClear: () => void;
  /** A user was banned or timed out: their messages are removed for everyone in the room. */
  onBan?: (userId: string, username: string) => void;
  /** Server notice and error codes (slow mode, bans, rejected messages…). */
  onNotice: (code: string, kind: "notice" | "error") => void;
}

const OPEN = 1;
export const MAX_MESSAGES = 200;

export class ChatConnection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private nonce = 0;
  status: ChatStatus = "closed";

  constructor(
    readonly channel: string,
    private readonly deps: ChatDeps,
    private readonly events: ChatEvents,
  ) {}

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }

  private clearTimer(handle: unknown): void {
    if (handle !== null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(handle);
  }

  private setStatus(s: ChatStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatus(s);
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus("connecting");
    let url: URL;
    try {
      const { token, url: base } = await this.deps.getToken();
      url = new URL(base);
      url.searchParams.set("token", token);
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const socket = this.deps.createSocket(url.toString());
    this.socket = socket;
    socket.addEventListener("message", (ev) => {
      if (this.socket === socket) this.handleFrame(ev.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimer(this.pingTimer);
      this.pingTimer = null;
      this.setStatus("closed");
      this.scheduleReconnect();
    });
    // `error` is always followed by `close`; reconnecting happens there.
    socket.addEventListener("error", () => undefined);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearTimer(this.reconnectTimer);
    const delay = backoffDelay(this.attempt++, {}, this.deps.random);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private raw(frame: ClientFrame): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  /** Parse and dispatch one server frame. Invalid frames are ignored. */
  handleFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerFrame.safeParse(json);
    if (!parsed.success) return;
    const f = parsed.data;
    switch (f.op) {
      case "welcome": {
        this.raw({ op: "join", channel: this.channel });
        this.clearTimer(this.pingTimer);
        const interval = Math.max(1_000, Math.floor(f.heartbeatMs / 2));
        const ping = () => {
          this.raw({ op: "ping" });
          this.pingTimer = this.setTimer(ping, interval);
        };
        this.pingTimer = this.setTimer(ping, interval);
        return;
      }
      case "joined":
        if (f.channel !== this.channel) return;
        this.attempt = 0;
        this.setStatus("open");
        this.events.onJoined({ canChat: f.me.canChat, canModerate: f.me.canModerate });
        return;
      case "message":
        if (f.channel === this.channel && !f.held) this.events.onMessage(f.message);
        return;
      case "delete":
        if (f.channel === this.channel) this.events.onDelete(f.messageId);
        return;
      case "clear":
        if (f.channel === this.channel) this.events.onClear();
        return;
      case "ban":
        if (f.channel === this.channel) this.events.onBan?.(f.userId, f.username);
        return;
      case "notice":
        if (f.channel === null || f.channel === this.channel) this.events.onNotice(f.code, "notice");
        return;
      case "error":
        this.events.onNotice(f.code, "error");
        return;
      default:
        return;
    }
  }

  /** Send a chat message; false when not connected. */
  send(body: string): boolean {
    const text = body.trim();
    if (!text || this.status !== "open") return false;
    return this.raw({ op: "send", channel: this.channel, body: text, isAction: false, nonce: `m${++this.nonce}` });
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer(this.reconnectTimer);
    this.clearTimer(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "bye");
    this.setStatus("closed");
  }
}

/** Append a message, dropping the oldest beyond `MAX_MESSAGES` and ignoring duplicates. */
export function appendMessage(list: ChatMessageFrame[], message: ChatMessageFrame): ChatMessageFrame[] {
  if (list.some((m) => m.id === message.id)) return list;
  const next = [...list, message];
  return next.length > MAX_MESSAGES ? next.slice(next.length - MAX_MESSAGES) : next;
}
