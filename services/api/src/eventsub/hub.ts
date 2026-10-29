// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The EventSub WebSocket hub (ADR 0027 §3): one per API process. It upgrades `GET /eventsub/ws`,
 * holds the sessions, keeps them alive, and fans `BUS.events` out to them after the same condition
 * and authorization checks the webhook path applies. One Valkey subscriber per process listens to
 * `BUS.events`, `BUS.userControl` (revocation closes sessions 4008) and `BUS.eventsubControl`
 * (another instance created or deleted a subscription, or took a session over). On SIGTERM it
 * drains: `session_reconnect` with a one-time resume URL to every session, then 4004 after the
 * grace. Never logged: tokens, resume tokens, payloads, client addresses.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Valkey } from "iovalkey";
import {
  EVENTSUB_WS_CLOSE,
  EVENTSUB_WS_KEEPALIVE,
  matchesCondition,
  subscriptionEnvelope,
} from "@commonair/contracts/eventsub";
import { BUS, BusEvent, EventSubControlMessage, UserControlMessage, type WsMessage } from "@commonair/contracts/events";
import { KEYS } from "@commonair/contracts/internal";
import { authorizeSubscription, notificationMessageId, uuidv7, type AuthorizationResult } from "@commonair/db";
import { meter } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { hmacHex, randomTokenSecret, sha256Hex } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { clientIp } from "../lib/ip.ts";
import { canonicalIp, rateLimitSubjectIp } from "../lib/netrange.ts";
import { rateLimitKey } from "../lib/ratelimit.ts";
import type { EventSub, EventSubSocketData } from "./index.ts";
import {
  afterSend,
  beforeSend,
  CLOSE_GOING_AWAY,
  CLOSE_MOVED,
  closeReason,
  controlAction,
  keepaliveMessage,
  notificationMessage,
  parseKeepalive,
  reconnectMessage,
  reconnectUrl,
  REVOKED_STATUS,
  revocationMessage,
  welcomeMessage,
  type CloseCode,
  type SessionBinding,
} from "./protocol.ts";
import { SessionStore } from "./sessions.ts";
import {
  deleteSessionSubscriptions,
  deleteSubscription,
  hasSubscription,
  loadSubscriptions,
  SubscriptionIndex,
  type WsSubscription,
} from "./subscriptions.ts";
import { sweepOrphans } from "./sweep.ts";

export interface EventSubOptions {
  /** Lowest `keepalive_timeout_seconds` accepted (10; tests lower it to keep runs short). */
  keepaliveMinSeconds: number;
  /** Keepalive and TTL-refresh timer. */
  tickMs: number;
  /** Full reload of the held sessions' subscriptions (safety net for a lost control message). */
  reloadMs: number;
  /** Per-subscription authorization cache. */
  authCacheMs: number;
  /** A socket buffering more than this is a slow consumer: closed 4000. */
  maxBufferedBytes: number;
  /** Sessions one process holds. */
  maxSessions: number;
  /** Orphan sweep period (under the leader lock). */
  sweepMs: number;
  /** Pause between start-up subscribe attempts. */
  warmRetryMs: number;
  /** Register `process.once("SIGTERM" | "SIGINT")` → `drain()` (off in tests). */
  handleSignals: boolean;
}

export const EVENTSUB_DEFAULTS: EventSubOptions = {
  keepaliveMinSeconds: EVENTSUB_WS_KEEPALIVE.minSeconds,
  tickMs: 1000,
  reloadMs: 60_000,
  authCacheMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
  maxSessions: 10_000,
  sweepMs: 5 * 60_000,
  warmRetryMs: 1000,
  handleSignals: true,
};

/** Above the 600 s keepalive maximum: Bun's default 120 s would close quiet sockets. */
export const WS_IDLE_TIMEOUT_SECONDS = 720;

/** Seams for tests: the subscriber connection, and a pause in a resume just before the welcome. */
export interface EventSubIo {
  connect(url: string): Valkey;
  beforeResumeWelcome?(sessionId: string): Promise<void>;
}

/** A resumed session waits at most this long to see its own takeover message on the bus. */
const RESUME_GATE_MS = 2000;
/** Messages held back for a session whose welcome has not gone out yet. */
const MAX_QUEUED = 1000;
export const DEFAULT_EVENTSUB_IO: EventSubIo = { connect: (url) => createValkey(url, { name: "api-eventsub-sub" }) };

interface Held {
  ws: ServerWebSocket<EventSubSocketData>;
  sessionId: string;
  keepaliveSeconds: number;
  connectedAt: Date;
  lastSentAt: number;
  lastRefreshAt: number;
  binding: SessionBinding | null;
  /** `session_welcome` went out (a resumed session first loads its state). */
  welcomed: boolean;
  /** Notifications and revocations that arrived before the welcome; sent right after it. */
  queue: WsMessage[];
  /** A revocation that arrived before the welcome: applied right after it. */
  revokeAfterWelcome: UserControlMessage["reason"] | null;
  /** Closed or closing by us, or moved: no more sends; the close handler has nothing to do. */
  ended: boolean;
  resumeHash: string | null;
  unusedTimer: ReturnType<typeof setTimeout> | null;
}

type AuthOutcome = AuthorizationResult | { error: true };

const m = meter("commonair.api");
const instruments = {
  sessions: m.createUpDownCounter("eventsub.ws.sessions", { description: "Open EventSub WebSocket sessions" }),
  sent: m.createCounter("eventsub.ws.messages", { description: "EventSub WebSocket messages sent, by type" }),
  closes: m.createCounter("eventsub.ws.closes", { description: "EventSub WebSocket closes, by code" }),
};

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export class EventSubHub implements EventSub {
  readonly instance = crypto.randomUUID();
  readonly store: SessionStore;
  readonly index = new SubscriptionIndex();
  private readonly held = new Map<string, Held>();
  private readonly authCache = new Map<string, { at: number; sessionId: string; result: Promise<AuthOutcome> }>();
  /** Session reloads in flight; a bus message waits for those started before it arrived. */
  private readonly pending = new Set<Promise<void>>();
  /**
   * Resumed sessions whose takeover message this subscriber has not seen yet. Events received
   * before it are the old holder's to deliver (it stops at that message), so each event goes out
   * once: on the old socket or on the new one, never both.
   */
  private readonly notLive = new Map<string, () => void>();
  private sub: Valkey | null = null;
  private subscribed = false;
  private starting = false;
  private stopped = false;
  private draining: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private refreshing = false;
  /** Where this instance's next sweep run continues (bounded work per run). */
  private sweepCursor: string | null = null;
  private readonly onSignal = () => void this.drain();
  private readonly counts = { sent: new Map<string, number>(), closes: new Map<number, number>() };

  readonly websocket: WebSocketHandler<EventSubSocketData>;

  constructor(
    private readonly deps: Deps,
    readonly opts: EventSubOptions = EVENTSUB_DEFAULTS,
    private readonly io: EventSubIo = DEFAULT_EVENTSUB_IO,
  ) {
    this.store = new SessionStore(deps.valkey, () => deps.env.EVENTSUB_WS_MAX_SESSIONS_PER_GRANT);
    this.websocket = {
      idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
      sendPings: true,
      // Any client frame closes the socket (4001). The cap only has to be high enough that Bun hands
      // the frame to `message` instead of closing 1009 itself.
      maxPayloadLength: 64 * 1024,
      open: (ws) => this.onOpen(ws),
      message: (ws) => this.onClientTraffic(ws),
      close: (ws, code) => this.onClose(ws, code),
    };
  }

  /** Readiness: the subscriber listens and the process is not draining. */
  get warm(): boolean {
    return this.subscribed && !this.draining && !this.stopped;
  }

  stats() {
    return {
      sessions: this.held.size,
      subscriptions: this.index.size,
      sent: Object.fromEntries(this.counts.sent),
      closes: Object.fromEntries(this.counts.closes),
    };
  }

  start(): void {
    if (this.starting || this.stopped) return;
    this.starting = true;
    if (this.opts.handleSignals) {
      process.once("SIGTERM", this.onSignal);
      process.once("SIGINT", this.onSignal);
    }
    this.timers.push(setInterval(() => this.tick(), this.opts.tickMs));
    this.timers.push(setInterval(() => void this.reloadAll(), this.opts.reloadMs));
    this.timers.push(setInterval(() => void this.sweep(), this.opts.sweepMs));
    for (const t of this.timers) t.unref?.();
    void (async () => {
      for (let attempt = 1; !this.stopped; attempt++) {
        try {
          await this.subscriber();
          this.deps.logger.info("eventsub subscriber ready", { attempts: attempt });
          return;
        } catch (err) {
          this.deps.logger.warn("eventsub subscriber start failed", { err: (err as Error).name, attempt });
        }
        await new Promise<void>((r) => {
          this.wake = r;
          setTimeout(r, this.opts.warmRetryMs).unref?.();
        });
      }
    })();
  }

  private async subscriber(): Promise<Valkey> {
    if (this.sub && this.subscribed) return this.sub;
    const sub = this.io.connect(this.deps.env.VALKEY_URL);
    sub.on("error", (err: Error) => this.deps.logger.warn("eventsub subscriber error", { err: err.name }));
    sub.on("message", (channel: string, message: string) => this.onBus(channel, message));
    try {
      await sub.subscribe(BUS.events, BUS.userControl, BUS.eventsubControl);
    } catch (err) {
      sub.disconnect();
      throw err;
    }
    if (this.stopped) {
      sub.disconnect();
      throw new Error("stopped");
    }
    this.sub = sub;
    this.subscribed = true;
    return sub;
  }

  // ---------------------------------------------------------------- connect

  async upgrade(req: Request, server: Server<EventSubSocketData>): Promise<Response | undefined> {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 400);
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket")
      return json({ error: "upgrade_required" }, 426, { upgrade: "websocket" });
    if (this.stopped || this.draining) return json({ error: "eventsub_unavailable" }, 503, { "retry-after": "1" });

    const url = new URL(req.url);
    const keepaliveRaw = url.searchParams.get("keepalive_timeout_seconds");
    const keepalive = parseKeepalive(keepaliveRaw, {
      ...EVENTSUB_WS_KEEPALIVE,
      minSeconds: this.opts.keepaliveMinSeconds,
    });
    if (keepalive === null) return json({ error: "invalid_keepalive_timeout_seconds" }, 400);

    const { deps } = this;
    try {
      const socketIp = server.requestIP(req)?.address ?? "0.0.0.0";
      const ip = canonicalIp(clientIp(socketIp, req.headers.get("x-forwarded-for"), deps.env.TRUSTED_PROXY_CIDRS));
      const limited = async (): Promise<Response | null> => {
        const subject = await hmacHex(deps.env.AUTH_SECRET, `rl:${rateLimitSubjectIp(ip)}`);
        const nowMs = deps.now().getTime();
        const rl = await deps.rateLimitStore.hit(
          rateLimitKey("auth", `ip:${subject}`),
          deps.rateLimits.auth,
          nowMs,
          `${nowMs}:${crypto.randomUUID()}`,
        );
        return rl.allowed
          ? null
          : json({ error: "rate_limited" }, 429, { "retry-after": String(rl.retryAfterSeconds) });
      };
      if (this.held.size >= this.opts.maxSessions)
        return json({ error: "eventsub_unavailable" }, 503, { "retry-after": "5" });

      const resume = url.searchParams.get("resume");
      let data: EventSubSocketData;
      let created = false;
      if (resume !== null) {
        // A valid resume token (one-time, 256-bit) is proof enough: a rolling upgrade moves every
        // session of a bot host at once and must not hit the limit. Only failed attempts are charged.
        const took = resume
          ? await this.store.takeover(await sha256Hex(resume), this.instance, keepaliveRaw === null ? null : keepalive)
          : null;
        if (!took) {
          const res = await limited();
          if (res) return res;
        }
        data = took
          ? {
              sessionId: took.sessionId,
              keepaliveSeconds: took.keepaliveSeconds,
              connectedAt: took.connectedAt.toISOString(),
              resumed: true,
            }
          : {
              sessionId: "",
              keepaliveSeconds: keepalive,
              connectedAt: deps.now().toISOString(),
              resumed: false,
              reject: EVENTSUB_WS_CLOSE.invalidReconnect,
            };
      } else {
        const res = await limited();
        if (res) return res;
        const connectedAt = deps.now();
        data = {
          sessionId: uuidv7(),
          keepaliveSeconds: keepalive,
          connectedAt: connectedAt.toISOString(),
          resumed: false,
        };
        await this.store.create(data.sessionId, { instance: this.instance, keepaliveSeconds: keepalive, connectedAt });
        created = true;
      }
      if (server.upgrade(req, { data })) return undefined;
      if (created) await this.store.end(data.sessionId, this.instance).catch(() => undefined);
      return json({ error: "upgrade_failed" }, 400);
    } catch (err) {
      deps.logger.warn("eventsub upgrade failed", { err: (err as Error).name });
      return json({ error: "eventsub_unavailable" }, 503, { "retry-after": "1" });
    }
  }

  private onOpen(ws: ServerWebSocket<EventSubSocketData>): void {
    const d = ws.data;
    if (d.reject !== undefined) {
      this.countClose(d.reject);
      ws.close(d.reject, closeReason(d.reject as CloseCode));
      return;
    }
    const now = Date.now();
    const held: Held = {
      ws,
      sessionId: d.sessionId,
      keepaliveSeconds: d.keepaliveSeconds,
      connectedAt: new Date(d.connectedAt),
      lastSentAt: now,
      lastRefreshAt: now,
      binding: null,
      welcomed: false,
      queue: [],
      revokeAfterWelcome: null,
      ended: false,
      resumeHash: null,
      unusedTimer: null,
    };
    // A session resumed onto the instance that already holds it (never while draining) replaces it.
    const previous = this.held.get(d.sessionId);
    if (previous) this.moved(previous);
    this.held.set(d.sessionId, held);
    instruments.sessions.add(1);
    if (d.resumed) void this.adopt(held);
    else this.welcome(held);
  }

  /**
   * A resumed session: tell the old holder at once (it stops delivering when it sees the message)
   * while loading the binding and subscriptions; bus messages wait for that load. Events this
   * subscriber received before its own takeover message are left to the old holder; events after
   * it are queued until the welcome, which goes out first.
   */
  private async adopt(held: Held): Promise<void> {
    const { sessionId } = held;
    let open = () => {};
    const live = new Promise<void>((resolve) => {
      open = resolve;
      this.notLive.set(sessionId, resolve);
      setTimeout(resolve, RESUME_GATE_MS).unref?.();
    }).then(() => {
      if (this.notLive.get(sessionId) === open) this.notLive.delete(sessionId);
    });
    const loaded = this.reloadSession(sessionId);
    this.pending.add(loaded);
    void loaded.finally(() => this.pending.delete(loaded));
    await this.deps.valkey
      .publish(BUS.eventsubControl, JSON.stringify({ op: "subscriptions_changed", sessionId }))
      .catch((err: unknown) => {
        // Without the message the old holder stops at its next reload; deliver from here now.
        this.deps.logger.warn("eventsub control publish failed", { err: (err as Error).name });
        this.notLive.get(sessionId)?.();
      });
    await Promise.all([loaded, live]);
    await this.io.beforeResumeWelcome?.(sessionId);
    this.welcome(held);
  }

  /** Notifications and revocations: held back until the welcome has gone out. */
  private emit(held: Held, msg: WsMessage): void {
    if (held.welcomed) {
      this.send(held, msg);
      return;
    }
    if (held.ended) return;
    if (held.queue.length >= MAX_QUEUED) {
      this.deps.logger.warn("eventsub pre-welcome queue overflow", { queued: held.queue.length });
      void this.closeSession(held, EVENTSUB_WS_CLOSE.internalError);
      return;
    }
    held.queue.push(msg);
  }

  private welcome(held: Held): void {
    if (held.ended) return;
    held.welcomed = true;
    this.notLive.get(held.sessionId)?.();
    this.send(
      held,
      welcomeMessage({
        messageId: uuidv7(),
        now: this.deps.now(),
        sessionId: held.sessionId,
        keepaliveSeconds: held.keepaliveSeconds,
        connectedAt: held.connectedAt,
      }),
    );
    for (const msg of held.queue.splice(0)) if (!this.send(held, msg)) return;
    if (held.revokeAfterWelcome) {
      void this.revokeSession(held, held.revokeAfterWelcome);
      return;
    }
    held.unusedTimer = setTimeout(
      () => void this.checkUsed(held),
      this.deps.env.EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS * 1000,
    );
  }

  private async checkUsed(held: Held): Promise<void> {
    held.unusedTimer = null;
    if (held.ended || this.index.of(held.sessionId).length > 0) return;
    try {
      if (await hasSubscription(this.deps.db, held.sessionId)) return;
    } catch (err) {
      // Fail open: the sweep cleans up an unused session's nothing; never close on a database hiccup.
      this.deps.logger.warn("eventsub unused-session check failed", { err: (err as Error).name });
      return;
    }
    await this.closeSession(held, EVENTSUB_WS_CLOSE.connectionUnused);
  }

  private onClientTraffic(ws: ServerWebSocket<EventSubSocketData>): void {
    const held = this.held.get(ws.data.sessionId);
    if (held && held.ws === ws) void this.closeSession(held, EVENTSUB_WS_CLOSE.clientSentTraffic);
    else ws.close(EVENTSUB_WS_CLOSE.clientSentTraffic, closeReason(EVENTSUB_WS_CLOSE.clientSentTraffic));
  }

  private onClose(ws: ServerWebSocket<EventSubSocketData>, code: number): void {
    const held = this.held.get(ws.data.sessionId);
    if (!held || held.ws !== ws || held.ended) return;
    // The client closed (or the connection dropped).
    this.countClose(code);
    void this.endSession(this.detach(held));
  }

  // ---------------------------------------------------------------- session end

  /** Stop tracking a held session (no more sends); returns it. */
  private detach(held: Held): Held {
    held.ended = true;
    if (held.unusedTimer) clearTimeout(held.unusedTimer);
    held.unusedTimer = null;
    held.queue = [];
    if (this.held.get(held.sessionId) === held) {
      this.notLive.get(held.sessionId)?.();
      this.held.delete(held.sessionId);
      this.index.remove(held.sessionId);
      this.dropAuth(held.sessionId);
      instruments.sessions.add(-1);
    }
    return held;
  }

  /** Delete the session's Valkey state and rows, unless another instance holds it now. */
  private async endSession(held: Held): Promise<void> {
    try {
      if (held.resumeHash) await this.store.dropResume(held.resumeHash);
      const r = await this.store.end(held.sessionId, this.instance);
      if (r !== 0) await deleteSessionSubscriptions(this.deps.db, held.sessionId);
    } catch (err) {
      // The sweep deletes the rows of a session whose key is gone.
      this.deps.logger.warn("eventsub session end failed", { err: (err as Error).name });
    }
  }

  /** Server-initiated close with an EventSub code; resolves once the session's state is gone. */
  private async closeSession(held: Held, code: CloseCode | typeof CLOSE_GOING_AWAY.code): Promise<void> {
    if (held.ended) return;
    this.detach(held);
    this.countClose(code);
    try {
      held.ws.close(code, code === CLOSE_GOING_AWAY.code ? CLOSE_GOING_AWAY.reason : closeReason(code));
    } catch {
      // already closed
    }
    await this.endSession(held);
  }

  /** Another instance took the session over: stop delivering and close this socket, keep its state. */
  private moved(held: Held): void {
    if (held.ended) return;
    this.detach(held);
    this.countClose(CLOSE_MOVED.code);
    try {
      held.ws.close(CLOSE_MOVED.code, CLOSE_MOVED.reason);
    } catch {
      // already closed
    }
  }

  private countClose(code: number): void {
    this.counts.closes.set(code, (this.counts.closes.get(code) ?? 0) + 1);
    instruments.closes.add(1, { code: String(code) });
  }

  // ---------------------------------------------------------------- sending

  private send(held: Held, msg: WsMessage): boolean {
    if (held.ended) return false;
    const { ws } = held;
    if (beforeSend(ws.getBufferedAmount(), this.opts.maxBufferedBytes) === "close") {
      this.deps.logger.warn("eventsub slow consumer closed", { buffered: ws.getBufferedAmount() });
      void this.closeSession(held, EVENTSUB_WS_CLOSE.internalError);
      return false;
    }
    if (afterSend(ws.send(JSON.stringify(msg))) === "dropped") {
      void this.closeSession(held, EVENTSUB_WS_CLOSE.internalError);
      return false;
    }
    held.lastSentAt = Date.now();
    const type = msg.metadata.message_type;
    this.counts.sent.set(type, (this.counts.sent.get(type) ?? 0) + 1);
    instruments.sent.add(1, { type });
    return true;
  }

  private tick(): void {
    const now = Date.now();
    const due: Held[] = [];
    for (const held of this.held.values()) {
      const keepaliveMs = held.keepaliveSeconds * 1000;
      // Send before the client's timeout runs out, not after: one tick of margin.
      const margin = Math.min(this.opts.tickMs, keepaliveMs / 4);
      if (held.welcomed && now - held.lastSentAt >= keepaliveMs - margin)
        this.send(held, keepaliveMessage(uuidv7(), this.deps.now()));
      if (now - held.lastRefreshAt >= keepaliveMs) due.push(held);
    }
    if (due.length > 0 && !this.refreshing) void this.refresh(due);
  }

  private async refresh(due: Held[]): Promise<void> {
    this.refreshing = true;
    try {
      const gone = new Set(await this.store.refresh(due));
      const now = Date.now();
      for (const held of due) {
        held.lastRefreshAt = now;
        if (!gone.has(held.sessionId) || held.ended) continue;
        await this.store.restore(held.sessionId, {
          instance: this.instance,
          keepaliveSeconds: held.keepaliveSeconds,
          connectedAt: held.connectedAt,
          binding: held.binding,
        });
      }
    } catch (err) {
      this.deps.logger.warn("eventsub session refresh failed", { err: (err as Error).name });
    } finally {
      this.refreshing = false;
    }
  }

  // ---------------------------------------------------------------- bus

  private onBus(channel: string, message: string): void {
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    // Reloads triggered by earlier messages finish first, so a subscription created (or a session
    // taken over) before an event was published is in the index when the event is fanned out.
    const before = [...this.pending];
    const after = (fn: () => Promise<void>) =>
      void (before.length ? Promise.all(before).then(fn) : fn()).catch((err: unknown) =>
        this.deps.logger.warn("eventsub fan-out failed", { err: (err as Error).name }),
      );
    if (channel === BUS.events) {
      if (this.held.size === 0) return;
      const ev = BusEvent.safeParse(data);
      // Snapshot at receipt: bus order decides which holder delivers this event.
      const skip = this.notLive.size > 0 ? new Set(this.notLive.keys()) : null;
      if (ev.success) after(() => this.deliver(ev.data, skip));
      return;
    }
    if (channel === BUS.userControl) {
      const msg = UserControlMessage.safeParse(data);
      if (msg.success) after(() => this.applyControl(msg.data));
      return;
    }
    if (channel === BUS.eventsubControl) {
      const msg = EventSubControlMessage.safeParse(data);
      if (!msg.success || !this.held.has(msg.data.sessionId)) return;
      this.notLive.get(msg.data.sessionId)?.();
      const p = this.reloadSession(msg.data.sessionId);
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    }
  }

  private async deliver(ev: BusEvent, skip: ReadonlySet<string> | null): Promise<void> {
    const subs = this.index
      .candidates(ev.type, ev.version)
      .filter((s) => !skip?.has(s.sessionId) && matchesCondition(s.condition, ev.payload, s.userId));
    await Promise.all(subs.map((s) => this.deliverOne(s, ev)));
  }

  private async deliverOne(sub: WsSubscription, ev: BusEvent): Promise<void> {
    if (!this.held.has(sub.sessionId)) return;
    const auth = await this.authorize(sub);
    const held = this.held.get(sub.sessionId);
    if (!held || held.ended || !this.index.has(sub.id)) return;
    if ("error" in auth) return;
    if (!auth.ok) {
      this.deps.logger.info("eventsub subscription revoked at delivery", {
        subscriptionId: sub.id,
        reason: auth.reason,
      });
      this.index.removeSubscription(sub.id);
      this.authCache.delete(sub.id);
      this.emit(
        held,
        revocationMessage({ messageId: uuidv7(), now: this.deps.now(), subscription: envelope(sub, REVOKED_STATUS) }),
      );
      await deleteSubscription(this.deps.db, sub.id).catch((err: unknown) =>
        this.deps.logger.warn("eventsub revoked row delete failed", { err: (err as Error).name }),
      );
      return;
    }
    this.emit(
      held,
      notificationMessage({
        messageId: notificationMessageId(sub.id, ev.id),
        now: this.deps.now(),
        subscription: envelope(sub),
        event: ev.payload,
      }),
    );
  }

  private authorize(sub: WsSubscription): Promise<AuthOutcome> {
    const now = Date.now();
    const hit = this.authCache.get(sub.id);
    if (hit && now - hit.at < this.opts.authCacheMs) return hit.result;
    const result: Promise<AuthOutcome> = authorizeSubscription(
      this.deps.db,
      { userId: sub.userId, appId: sub.appId, condition: sub.condition },
      sub.type,
      this.deps.now(),
    ).catch((err: unknown) => {
      this.deps.logger.warn("eventsub authorization check failed", { err: (err as Error).name });
      if (this.authCache.get(sub.id)?.result === result) this.authCache.delete(sub.id);
      return { error: true } as const;
    });
    this.authCache.set(sub.id, { at: now, sessionId: sub.sessionId, result });
    return result;
  }

  private dropAuth(sessionId: string): void {
    for (const [id, e] of this.authCache) if (e.sessionId === sessionId) this.authCache.delete(id);
  }

  private async applyControl(msg: UserControlMessage): Promise<void> {
    if (msg.op === "disconnect") {
      // Bindings change without a control message (a bind whose subscribe then failed, or a later
      // bind with a refreshed token): match against Valkey, not memory. One pipeline; revocations
      // are rare.
      const live = [...this.held.values()].filter((h) => !h.ended);
      if (live.length > 0) {
        const recs = await this.store.getMany(live.map((h) => h.sessionId));
        for (const h of live) {
          const rec = recs.get(h.sessionId);
          if (rec && rec.instance === this.instance) h.binding = rec.binding;
        }
      }
    }
    const closing: Promise<void>[] = [];
    for (const held of this.held.values()) {
      const action = controlAction(held.binding, msg);
      if (action === "none") continue;
      this.dropAuth(held.sessionId);
      if (action === "close") closing.push(this.revokeSession(held, msg.reason));
    }
    await Promise.all(closing);
  }

  /** `revocation` per subscription, rows deleted, close 4008. */
  private async revokeSession(held: Held, reason: UserControlMessage["reason"]): Promise<void> {
    if (held.ended) return;
    if (!held.welcomed) {
      held.revokeAfterWelcome = reason;
      return;
    }
    const subs = this.index.of(held.sessionId);
    const now = this.deps.now();
    for (const s of subs)
      this.send(held, revocationMessage({ messageId: uuidv7(), now, subscription: envelope(s, REVOKED_STATUS) }));
    this.deps.logger.info("eventsub session revoked", { reason, subscriptions: subs.length });
    await this.closeSession(held, EVENTSUB_WS_CLOSE.authorizationRevoked);
  }

  /** Reload one held session's binding and subscriptions; a session another instance took over is let go. */
  private async reloadSession(sessionId: string): Promise<void> {
    const held = this.held.get(sessionId);
    if (!held) return;
    try {
      const [rec, subs] = await Promise.all([this.store.get(sessionId), loadSubscriptions(this.deps.db, [sessionId])]);
      if (held.ended || this.held.get(sessionId) !== held) return;
      if (rec && rec.instance !== this.instance) {
        this.moved(held);
        return;
      }
      if (rec) held.binding = rec.binding;
      this.index.set(sessionId, subs);
    } catch (err) {
      this.deps.logger.warn("eventsub session reload failed", { err: (err as Error).name });
    }
  }

  /** The periodic safety net: every held session's binding and subscriptions from the source. */
  async reloadAll(): Promise<void> {
    const ids = [...this.held.keys()];
    if (ids.length === 0) return;
    try {
      const [recs, subs] = await Promise.all([this.store.getMany(ids), loadSubscriptions(this.deps.db, ids)]);
      const grouped = new Map<string, WsSubscription[]>();
      for (const s of subs) grouped.set(s.sessionId, [...(grouped.get(s.sessionId) ?? []), s]);
      for (const id of ids) {
        const held = this.held.get(id);
        if (!held || held.ended) continue;
        const rec = recs.get(id);
        if (rec && rec.instance !== this.instance) {
          this.moved(held);
          continue;
        }
        if (rec) held.binding = rec.binding;
        this.index.set(id, grouped.get(id) ?? []);
      }
    } catch (err) {
      this.deps.logger.warn("eventsub reload failed", { err: (err as Error).name });
    }
  }

  async sweep(): Promise<number> {
    const { deps } = this;
    try {
      if (!(await this.store.tryLock(KEYS.eventsubSweepLock, this.instance, Math.max(1000, this.opts.sweepMs - 1000))))
        return 0;
      const { deleted: n, cursor } = await sweepOrphans(
        deps.db,
        this.store,
        deps.now(),
        deps.env.EVENTSUB_WS_RECONNECT_GRACE_SECONDS * 1000,
        this.sweepCursor,
      );
      this.sweepCursor = cursor;
      if (n > 0) deps.logger.info("eventsub orphaned subscriptions swept", { deleted: n });
      return n;
    } catch (err) {
      deps.logger.warn("eventsub sweep failed", { err: (err as Error).name });
      return 0;
    }
  }

  // ---------------------------------------------------------------- shutdown

  /**
   * Rolling upgrade: `session_reconnect` with a one-time resume URL to every session, wait until
   * each has moved to another instance or the grace passes, then close the rest with 4004.
   */
  drain(): Promise<void> {
    this.draining ??= this.runDrain();
    return this.draining;
  }

  private async runDrain(): Promise<void> {
    const { deps } = this;
    const grace = deps.env.EVENTSUB_WS_RECONNECT_GRACE_SECONDS;
    const sessions = [...this.held.values()].filter((h) => !h.ended);
    deps.logger.info("eventsub draining", { sessions: sessions.length, graceSeconds: grace });
    await Promise.all(
      sessions.map(async (held) => {
        const token = randomTokenSecret("ces_");
        const hash = await sha256Hex(token);
        try {
          await this.store.putResume(hash, held.sessionId, grace);
        } catch (err) {
          deps.logger.warn("eventsub resume token store failed", { err: (err as Error).name });
          return;
        }
        held.resumeHash = hash;
        this.send(
          held,
          reconnectMessage({
            messageId: uuidv7(),
            now: deps.now(),
            sessionId: held.sessionId,
            connectedAt: held.connectedAt,
            reconnectUrl: reconnectUrl(deps.site.publicUrl, token),
          }),
        );
      }),
    );
    const until = Date.now() + grace * 1000;
    let lastReload = Date.now();
    while (this.held.size > 0 && Date.now() < until) {
      await Bun.sleep(Math.min(250, Math.max(1, until - Date.now())));
      // Moves arrive as control messages; a reload also catches one whose message was lost.
      if (this.held.size > 0 && Date.now() - lastReload >= 2000) {
        lastReload = Date.now();
        await this.reloadAll();
      }
    }
    await Promise.all(
      [...this.held.values()].map((h) => this.closeSession(h, EVENTSUB_WS_CLOSE.reconnectGraceExpired)),
    );
    deps.logger.info("eventsub drained", { closes: Object.fromEntries(this.counts.closes) });
  }

  /** Stop without a drain (tests, and the close list): sessions end, the subscriber goes. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.wake?.();
    process.off("SIGTERM", this.onSignal);
    process.off("SIGINT", this.onSignal);
    for (const t of this.timers) clearInterval(t);
    await Promise.all([...this.held.values()].map((h) => this.closeSession(h, CLOSE_GOING_AWAY.code)));
    this.subscribed = false;
    const sub = this.sub;
    this.sub = null;
    sub?.disconnect();
  }
}

function envelope(sub: WsSubscription, status?: string) {
  return subscriptionEnvelope(
    {
      id: sub.id,
      type: sub.type,
      version: sub.version,
      status: "enabled",
      condition: sub.condition,
      transport: "websocket",
      callbackUrl: null,
      websocketSessionId: sub.sessionId,
      createdAt: sub.createdAt,
    },
    status,
  );
}
