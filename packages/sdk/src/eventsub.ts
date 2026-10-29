// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * EventSub over WebSocket (ADR 0027 §3, Twitch-shaped). The server sends `session_welcome`; you
 * subscribe over HTTP with that session id within 10 seconds (`subscribe`); notifications arrive on
 * the socket. This client:
 *
 * - validates every message with the contract's `WsMessage` schema and drops what does not parse;
 * - runs a keepalive watchdog: no message for `keepalive_timeout_seconds` + 2 s means the socket is
 *   dead, so it reconnects from scratch (a new session: resubscribe in `onNewSession`);
 * - follows `session_reconnect`: opens `reconnect_url`, waits for its welcome (same session id),
 *   then closes the old socket, delivering no message twice (dedupe by `message_id`);
 * - stops for good on a policy close (4001, 4003, 4007, 4008). 4008 means the authorization was
 *   revoked: `closed` resolves with `reauthorize: true`. A token refresh never closes a session.
 */
import { EVENTSUB_WS_CLOSE, EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import { WsMessage, type PublicEventType } from "@commonair/contracts/events";
import type { CommonAirClient } from "./client.ts";
import { trimBase } from "./client.ts";
import { createDedupe } from "./webhooks.ts";

export type { WsMessage };
export type EventSubMessageType = WsMessage["metadata"]["message_type"];
export type EventSubCloseName = keyof typeof EVENTSUB_WS_CLOSE;

/** The name of an EventSub close code, or null for any other code. */
export function closeCodeName(code: number): EventSubCloseName | null {
  for (const [name, c] of Object.entries(EVENTSUB_WS_CLOSE)) if (c === code) return name as EventSubCloseName;
  return null;
}

/** Codes after which reconnecting cannot help (the client broke a rule, or the grant is gone). */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  EVENTSUB_WS_CLOSE.clientSentTraffic,
  EVENTSUB_WS_CLOSE.connectionUnused,
  EVENTSUB_WS_CLOSE.invalidReconnect,
  EVENTSUB_WS_CLOSE.authorizationRevoked,
]);

export interface EventSubClose {
  code: number;
  reason: string;
  /** `EVENTSUB_WS_CLOSE` name of the code, when it is one. */
  name: EventSubCloseName | null;
  /** 4008: the user revoked the app (or it was suspended): authorize again before resubscribing. */
  reauthorize: boolean;
  /** True when `close()` ended it. */
  byClient: boolean;
}

export interface EventSubNotification {
  messageId: string;
  subscriptionType: PublicEventType;
  subscriptionId: string;
  event: Record<string, unknown>;
  message: WsMessage;
}

export interface EventSubRevocation {
  subscriptionId: string;
  subscriptionType: PublicEventType;
  /** Twitch-compatible status, e.g. `authorization_revoked`. */
  status: string;
  message: WsMessage;
}

/** A WebSocket constructor: the global one (Bun, Node ≥ 22, browsers, Deno) or e.g. `ws`. */
export type WebSocketConstructor = new (url: string) => WebSocket;

export interface EventSubOptions {
  /** API origin; the socket goes to `${baseUrl as ws(s)}${EVENTSUB_WS_PATH}`. */
  baseUrl?: string;
  /** Full WebSocket URL instead of `baseUrl`. */
  url?: string;
  /** 10-600; the server's default (10) when absent. */
  keepaliveSeconds?: number;
  WebSocket?: WebSocketConstructor;
  /**
   * After a reconnect from scratch (watchdog or network): the new session id. Subscriptions do not
   * carry over; subscribe again here (within 10 seconds).
   */
  onNewSession?: (sessionId: string) => void | Promise<void>;
  /** Invalid frames, failed `onNewSession` calls and failed reconnect attempts. */
  onError?: (error: Error) => void;
  /** Wait at most this long for `session_welcome` (default 10 000 ms). */
  welcomeTimeoutMs?: number;
  /** Slack added to the keepalive before the watchdog fires (default 2 000 ms). */
  watchdogGraceMs?: number;
  /** How many message ids to remember for dedupe (default 1000). */
  dedupeWindow?: number;
  /** Backoff between reconnect attempts: first and maximum delay (default 1 000 and 30 000 ms). */
  reconnectDelayMs?: { initial: number; max: number };
}

export interface EventSubSession {
  /** The current session id (changes only after a reconnect from scratch). */
  readonly sessionId: string;
  on(type: EventSubMessageType, handler: (message: WsMessage) => void): () => void;
  onNotification(handler: (n: EventSubNotification) => void): () => void;
  onRevocation(handler: (r: EventSubRevocation) => void): () => void;
  /** Resolves once the client stopped for good (`close()`, or a policy close). */
  readonly closed: Promise<EventSubClose>;
  close(): void;
}

/** `ws(s)://host/eventsub/ws[?keepalive_timeout_seconds=]` for an API origin. */
export function eventSubUrl(baseUrl: string, keepaliveSeconds?: number): string {
  const u = new URL(`${trimBase(baseUrl)}${EVENTSUB_WS_PATH}`);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  if (keepaliveSeconds !== undefined) u.searchParams.set("keepalive_timeout_seconds", String(keepaliveSeconds));
  return u.toString();
}

interface Socket {
  ws: WebSocket;
  /** Resolves with the welcome, rejects if the socket closes or times out first. */
  welcome: Promise<WsMessage>;
  closedByUs: boolean;
}

class Session implements EventSubSession {
  // Set by start() before connectEventSub returns the session; nothing reads it earlier.
  private current!: Socket;
  private handover: Socket | null = null;
  private id = "";
  /** The first session was welcomed (until then a close is start()'s failure, not a reconnect). */
  private started = false;
  private keepaliveMs = 10_000;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly handlers = new Map<EventSubMessageType, Set<(m: WsMessage) => void>>();
  private readonly dedupe;
  private ended = false;
  private reconnecting = false;
  // Assigned synchronously by the Promise executor in the constructor.
  private resolveClosed!: (c: EventSubClose) => void;
  readonly closed: Promise<EventSubClose>;
  private readonly Ws: WebSocketConstructor;
  private readonly url: string;

  constructor(private readonly opts: EventSubOptions) {
    this.dedupe = createDedupe(opts.dedupeWindow ?? 1000);
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    const Ws = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!Ws) throw new Error("no WebSocket implementation: pass `WebSocket`");
    this.Ws = Ws;
    if (opts.url) this.url = opts.url;
    else if (opts.baseUrl) this.url = eventSubUrl(opts.baseUrl, opts.keepaliveSeconds);
    else throw new Error("connectEventSub needs `baseUrl` or `url`");
  }

  get sessionId(): string {
    return this.id;
  }

  async start(): Promise<void> {
    const s = this.open(this.url);
    this.current = s;
    try {
      this.adopt(await s.welcome);
      this.started = true;
    } catch (err) {
      this.ended = true;
      this.stopWatchdog();
      s.closedByUs = true;
      s.ws.close();
      throw err;
    }
  }

  private emitError(err: unknown) {
    this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  private open(url: string): Socket {
    const ws = new this.Ws(url);
    // Both assigned synchronously by the Promise executor below.
    let resolveWelcome!: (m: WsMessage) => void;
    let rejectWelcome!: (e: Error) => void;
    const welcome = new Promise<WsMessage>((res, rej) => {
      resolveWelcome = res;
      rejectWelcome = rej;
    });
    welcome.catch(() => undefined);
    const timer = setTimeout(
      () => rejectWelcome(new Error("eventsub: no session_welcome in time")),
      this.opts.welcomeTimeoutMs ?? 10_000,
    );
    const s: Socket = { ws, welcome, closedByUs: false };
    let welcomed = false;
    ws.addEventListener("message", (ev) => {
      const msg = this.parse(ev.data);
      if (!msg) return;
      if (!welcomed && msg.metadata.message_type === "session_welcome") {
        welcomed = true;
        clearTimeout(timer);
        resolveWelcome(msg);
        return;
      }
      this.onMessage(s, msg);
    });
    ws.addEventListener("close", (ev) => {
      clearTimeout(timer);
      if (!welcomed) rejectWelcome(new Error(`eventsub: closed before session_welcome (${ev.code})`));
      this.onSocketClose(s, ev.code, ev.reason);
    });
    // An error is always followed by a close event; the close handler decides.
    ws.addEventListener("error", () => undefined);
    return s;
  }

  private parse(data: unknown): WsMessage | null {
    let json: unknown;
    try {
      json = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      this.emitError(new Error("eventsub: a frame was not JSON"));
      return null;
    }
    const r = WsMessage.safeParse(json);
    if (!r.success) {
      this.emitError(new Error("eventsub: a frame did not match the message schema"));
      return null;
    }
    return r.data;
  }

  /** Make a welcome current: its session id and keepalive. */
  private adopt(welcome: WsMessage) {
    const session = welcome.payload.session;
    if (!session) throw new Error("eventsub: session_welcome without a session");
    this.id = session.id;
    if (session.keepalive_timeout_seconds !== null) this.keepaliveMs = session.keepalive_timeout_seconds * 1000;
    this.dedupe.firstSeen(welcome.metadata.message_id);
    this.dispatch(welcome);
    this.resetWatchdog();
  }

  private onMessage(s: Socket, msg: WsMessage) {
    if (this.ended) return;
    // Traffic on the socket that carries the session proves it alive.
    if (s === this.current || s === this.handover) this.resetWatchdog();
    if (!this.dedupe.firstSeen(msg.metadata.message_id)) return;
    if (msg.metadata.message_type === "session_reconnect") {
      const url = msg.payload.session?.reconnect_url;
      this.dispatch(msg);
      if (url) void this.handOver(url);
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: WsMessage) {
    for (const h of this.handlers.get(msg.metadata.message_type) ?? []) {
      try {
        h(msg);
      } catch (err) {
        this.emitError(err);
      }
    }
  }

  /** `session_reconnect`: the new socket takes the session over; the old one is closed after its welcome. */
  private async handOver(url: string) {
    if (this.handover) return;
    const next = this.open(url);
    this.handover = next;
    try {
      const welcome = await next.welcome;
      if (this.ended) {
        next.closedByUs = true;
        next.ws.close();
        return;
      }
      const old = this.current;
      this.current = next;
      this.handover = null;
      this.adopt(welcome);
      old.closedByUs = true;
      old.ws.close(1000, "reconnected");
    } catch (err) {
      this.handover = null;
      next.closedByUs = true;
      next.ws.close();
      this.emitError(err);
      // The old socket closes after the grace anyway: start over now rather than lose events later.
      if (!this.ended) void this.reconnectFromScratch();
    }
  }

  private onSocketClose(s: Socket, code: number, reason: string) {
    // Before the first welcome, start() owns the failure: connectEventSub rejects, nothing reconnects.
    if (s.closedByUs || s !== this.current || this.ended || !this.started) return;
    if (TERMINAL_CODES.has(code)) {
      this.finish({
        code,
        reason,
        name: closeCodeName(code),
        reauthorize: code === EVENTSUB_WS_CLOSE.authorizationRevoked,
        byClient: false,
      });
      return;
    }
    void this.reconnectFromScratch();
  }

  private stopWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private resetWatchdog() {
    this.stopWatchdog();
    if (this.ended) return;
    this.watchdog = setTimeout(
      () => {
        this.emitError(new Error("eventsub: keepalive missed, reconnecting"));
        void this.reconnectFromScratch();
      },
      this.keepaliveMs + (this.opts.watchdogGraceMs ?? 2_000),
    );
  }

  /** Drop the current socket and open a new session at the original URL, with backoff until it works. */
  private async reconnectFromScratch() {
    if (this.reconnecting || this.ended) return;
    this.reconnecting = true;
    this.stopWatchdog();
    const old = this.current;
    old.closedByUs = true;
    old.ws.close();
    if (this.handover) {
      this.handover.closedByUs = true;
      this.handover.ws.close();
      this.handover = null;
    }
    const delays = this.opts.reconnectDelayMs ?? { initial: 1_000, max: 30_000 };
    let delay = delays.initial;
    try {
      for (let attempt = 0; !this.ended; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(delay * 2, delays.max);
          if (this.ended) return;
        }
        const s = this.open(this.url);
        this.current = s;
        try {
          const welcome = await s.welcome;
          if (this.ended) {
            s.closedByUs = true;
            s.ws.close();
            return;
          }
          this.adopt(welcome);
          break;
        } catch (err) {
          s.closedByUs = true;
          s.ws.close();
          this.emitError(err);
        }
      }
    } finally {
      this.reconnecting = false;
    }
    if (this.ended) return;
    try {
      await this.opts.onNewSession?.(this.id);
    } catch (err) {
      this.emitError(err);
    }
  }

  private finish(c: EventSubClose) {
    if (this.ended) return;
    this.ended = true;
    this.stopWatchdog();
    for (const s of [this.current, this.handover]) {
      if (!s) continue;
      s.closedByUs = true;
      if (s.ws.readyState === 0 || s.ws.readyState === 1) s.ws.close(1000, "bye");
    }
    this.resolveClosed(c);
  }

  on(type: EventSubMessageType, handler: (message: WsMessage) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  onNotification(handler: (n: EventSubNotification) => void): () => void {
    return this.on("notification", (m) => {
      const sub = m.payload.subscription;
      if (!sub || !m.payload.event) return;
      handler({
        messageId: m.metadata.message_id,
        subscriptionType: sub.type,
        subscriptionId: sub.id,
        event: m.payload.event,
        message: m,
      });
    });
  }

  onRevocation(handler: (r: EventSubRevocation) => void): () => void {
    return this.on("revocation", (m) => {
      const sub = m.payload.subscription;
      if (!sub) return;
      handler({ subscriptionId: sub.id, subscriptionType: sub.type, status: sub.status, message: m });
    });
  }

  close(): void {
    this.finish({ code: 1000, reason: "closed by client", name: null, reauthorize: false, byClient: true });
  }
}

/** Connect and wait for `session_welcome`. Subscribe with the returned `sessionId` within 10 seconds. */
export async function connectEventSub(opts: EventSubOptions): Promise<EventSubSession> {
  const s = new Session(opts);
  await s.start();
  return s;
}

export interface SubscribeOptions {
  type: PublicEventType;
  condition: Record<string, string>;
  sessionId: string;
  version?: string;
}

/** Create a WebSocket subscription on a session (`developer.events.subscribe`). */
export function subscribe(client: CommonAirClient, opts: SubscribeOptions) {
  return client.developer.events.subscribe({
    type: opts.type,
    version: opts.version ?? "1",
    condition: opts.condition,
    transport: { method: "websocket", sessionId: opts.sessionId },
  });
}
