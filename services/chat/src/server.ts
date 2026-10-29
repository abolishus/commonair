// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat WebSocket server (`/ws`). Wires authentication, per-socket frame handling,
 * heartbeats, Valkey fan-out and shutdown around `ChatCore`.
 */
import { sql } from "drizzle-orm";
import type { Server } from "bun";
import { ClientFrame } from "@commonair/contracts";
import type { Database } from "@commonair/db";
import { createLogger, type Logger } from "@commonair/observability";
import { createValkey, runService, valkeyCheck, type RunningService, type ValkeyClient } from "@commonair/service";
import { Authenticator } from "./auth.ts";
import { Bus } from "./bus.ts";
import { splitChatCommand } from "./commands.ts";
import { ChatCore, REQUIRES_LOGIN } from "./core.ts";
import { Directory, type DirectoryOptions } from "./directory.ts";
import { type Limiter, ValkeyLimiter } from "./limiter.ts";
import { createMetrics } from "./metrics.ts";
import { MODERATE_SCOPE, Moderation } from "./moderation.ts";
import { type FilterRunner, inlineFilterRunner, WorkerFilterRunner } from "./filter-runner.ts";
import { MessageWriter, type WriterOptions } from "./persistence.ts";
import { errorFields } from "./errors.ts";
import { BUS, UserControlMessage, userControlTargets } from "@commonair/contracts";
import { parseJson } from "./control.ts";
import type { MessageMiddleware, PluginHost } from "./pipeline.ts";
import { plugins } from "./plugins/index.ts";
import { Rooms } from "./rooms.ts";
import { type ChatSocket, CLOSE, type ConnData, sendFrame, sendNotice, takeToken, type Writer } from "./socket.ts";
import type { Identity, Rejection } from "./types.ts";
import { warmPool } from "./pool.ts";
import { DeadlineError, watchEventLoop, withDeadline } from "./watchdog.ts";

export interface ChatServiceOptions {
  port: number;
  hostname?: string;
  db: Database;
  valkeyUrl: string;
  /** Valkey key prefix (rate limits, slow mode, duplicates). Tests isolate with a unique one. */
  keyPrefix?: string;
  /** Prefix for pub/sub channel names (keyPrefix does not apply to pub/sub). */
  busPrefix?: string;
  internalSecret: string;
  heartbeatMs?: number;
  /** Per-socket send buffer above which the socket is terminated as a slow consumer. */
  maxBufferedBytes?: number;
  maxRoomsPerConnection?: number;
  writer?: WriterOptions;
  directory?: DirectoryOptions;
  middlewares?: readonly MessageMiddleware[];
  limiter?: Limiter;
  logger?: Logger;
  deleteRetryMs?: number;
  /** How long an OAuth token's validity is cached between re-checks (≤ 30 s). */
  oauthRevalidateMs?: number;
  /**
   * Word-filter worker threads (default 2). 0 runs filters inline, without the hard timeout on a
   * single regex call.
   */
  filterWorkers?: number;
  /**
   * Bound on the awaits before a WebSocket upgrade (token check, profile read). Past it the
   * client gets a 503 instead of an upgrade that never answers. Default 5 s.
   */
  upgradeTimeoutMs?: number;
  /**
   * Pool connections opened at start-up, retried until they all succeed; /readyz fails until
   * then (default 0: lazy). See pool.ts.
   */
  warmConnections?: number;
  /** Runs last during shutdown (close the DB pool, flush telemetry). */
  onShutdown?: () => Promise<void>;
}

export interface ChatService {
  url: URL;
  /** ws:// URL of the chat endpoint. */
  wsUrl: string;
  connections(): number;
  /** Flush buffered chat messages to Postgres. */
  flush(): Promise<void>;
  stop(): Promise<void>;
}

const MAX_PENDING_FRAMES = 32;
/** Upgrades taking at least this long are logged with the user id, to trace dependency stalls. */
const SLOW_UPGRADE_MS = 1_000;
const MAX_BAD_FRAMES = 20;

export async function startChatService(opts: ChatServiceOptions): Promise<ChatService> {
  const logger = opts.logger ?? createLogger({ service: "chat" });
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const upgradeTimeoutMs = opts.upgradeTimeoutMs ?? 5_000;
  const metrics = createMetrics();
  const valkey = createValkey(opts.valkeyUrl, { keyPrefix: opts.keyPrefix, name: "chat" });
  const subscriber = createValkey(opts.valkeyUrl, { name: "chat-sub" });
  watchValkey(valkey, "chat", logger);
  watchValkey(subscriber, "chat-sub", logger);
  const pool = warmPool(opts.db, opts.warmConnections ?? 0, logger);
  const stopLagWatch = watchEventLoop((lagMs) => logger.warn("event loop stalled", { lagMs }));
  const bus = new Bus(valkey, subscriber, opts.busPrefix ?? "", logger);
  const directory = new Directory(opts.db, {
    onInvalidFilter: (channelId, filterId, reason) => {
      metrics.filterSkipped(reason);
      logger.warn("word filter skipped", { channelId, filterId, reason });
    },
    ...opts.directory,
  });
  const writer = new MessageWriter(opts.db, logger, metrics, opts.writer);
  const frameWriter: Writer = { maxBufferedBytes: opts.maxBufferedBytes ?? 1024 * 1024, metrics };
  const middlewares = opts.middlewares ?? plugins;
  const sockets = new Set<ChatSocket>();
  const auth = new Authenticator(opts.db, opts.internalSecret, opts.oauthRevalidateMs);
  const filterRunner: FilterRunner =
    opts.filterWorkers === 0
      ? inlineFilterRunner
      : new WorkerFilterRunner({
          workers: opts.filterWorkers,
          logger,
          hooks: {
            held: (reason) => metrics.filterHeld(reason),
            quarantined: () => metrics.filterQuarantined(),
            zombies: (delta) => metrics.filterZombies(delta),
          },
        });

  /** BUS.userControl: platform-wide suspension, deletion, token revocation, role/profile changes. */
  const onUserControl = (raw: string): void => {
    const msg = parseJson(UserControlMessage, raw);
    if (!msg) return;
    if (msg.tokenHash) auth.forget(msg.tokenHash);
    if (msg.userId) core?.invalidateUser(msg.userId);
    if (msg.op !== "disconnect") return;
    // `{ appId }` alone closes every socket of the app, browser chat-token sockets included
    // (`claims.app`); with `userId` only that grant's; `token_rotated` closes the old token's.
    for (const ws of sockets) if (userControlTargets(ws.data.identity, msg)) expire(ws, msg.reason);
  };
  let draining = false;

  // `core` is assigned right below; room handlers only fire after a join, which needs it.
  let core: ChatCore | undefined;
  const rooms = new Rooms(
    bus,
    {
      onChat: (id, raw) => core?.onChat(id, raw),
      onControl: (id, raw) => core?.onControl(id, raw),
      onRelease: (id) => directory.evictChannel(id),
    },
    frameWriter,
  );
  const moderation = new Moderation({
    db: opts.db,
    directory,
    publishControl: (channelId, message) => bus.publish(bus.names.control(channelId), JSON.stringify(message)),
    // Bounded: a delete must not wait behind a backlog during a database outage.
    flushMessages: async () => {
      await writer.flushWithin(1_000);
    },
    logger,
    deleteRetryMs: opts.deleteRetryMs,
  });
  const chat = new ChatCore({
    db: opts.db,
    bus,
    rooms,
    directory,
    limiter: opts.limiter ?? new ValkeyLimiter(valkey),
    writer,
    moderation,
    middlewares,
    metrics,
    logger,
    frameWriter,
    maxRoomsPerConnection: opts.maxRoomsPerConnection ?? 100,
    filterRunner,
  });
  core = chat;

  await Promise.all([
    bus.acquire(bus.names.events(), (raw) => chat.onEvent(raw)),
    bus.acquire(bus.names.live(), (raw) => chat.onLive(raw)),
    bus.acquire((opts.busPrefix ?? "") + BUS.userControl, (raw) => onUserControl(raw)),
  ]);
  await initPlugins(middlewares, {
    chat,
    rooms,
    bus,
    busPrefix: opts.busPrefix ?? "",
    db: opts.db,
    valkey,
    logger,
  });

  /** Reply addressing for a frame: the IRC gateway pairs replies with requests by nonce. */
  type Reply = { channel: string | null; nonce: string | undefined };
  const replyTo = (f: ClientFrame): Reply => ({
    channel: "channel" in f ? f.channel.toLowerCase() : null,
    nonce: f.nonce,
  });

  const replyNotice = (ws: ChatSocket, to: Reply, n: Rejection): void => {
    sendNotice(ws, { ...to, ...n }, frameWriter);
  };
  const replyError = (ws: ChatSocket, to: Reply, code: string, message: string): void => {
    const where = { ...(to.channel ? { channel: to.channel } : {}), ...(to.nonce ? { nonce: to.nonce } : {}) };
    sendFrame(ws, { op: "error", code, message, ...where }, frameWriter);
  };

  /** Close a socket whose credentials lapsed or were revoked. */
  const expire = (ws: ChatSocket, reason: string): void => {
    metrics.dropped("credentials");
    ws.close(CLOSE.credentials, reason);
  };

  /** Send and command need live credentials and a joined room (so this instance hears its control channel). */
  const precheck = async (ws: ChatSocket, frame: ClientFrame & { channel: string }, to: Reply): Promise<boolean> => {
    const id = ws.data.identity;
    const isMe = frame.op === "command" && frame.command === "me";
    if (!id.userId || (frame.op === "send" || isMe ? !id.scopes.includes("chat:edit") : false)) {
      replyNotice(ws, to, REQUIRES_LOGIN);
      if (frame.op === "send") sendFrame(ws, { op: "ack", nonce: frame.nonce, id: null, held: false }, frameWriter);
      return false;
    }
    if (!(await auth.stillValid(id))) {
      replyNotice(ws, to, { code: "msg_requires_login", text: "Your credentials expired or were revoked." });
      // Every send is answered by an ack, so a client waiting on it does not hang until the close.
      if (frame.op === "send") sendFrame(ws, { op: "ack", nonce: frame.nonce, id: null, held: false }, frameWriter);
      expire(ws, "credentials expired");
      return false;
    }
    if (!ws.data.rooms.has(frame.channel.toLowerCase())) {
      replyNotice(ws, to, { code: "msg_rejected", text: "Join the channel first." });
      if (frame.op === "send") sendFrame(ws, { op: "ack", nonce: frame.nonce, id: null, held: false }, frameWriter);
      return false;
    }
    return true;
  };

  const handleFrame = async (ws: ChatSocket, frame: ClientFrame): Promise<void> => {
    const data = ws.data;
    const to = replyTo(frame);
    if ((frame.op === "send" || frame.op === "command") && !(await precheck(ws, frame, to))) return;
    switch (frame.op) {
      case "ping":
        sendFrame(ws, { op: "pong", nonce: frame.nonce }, frameWriter);
        return;
      case "join":
      case "part":
      case "command":
        if (!takeToken(data, Date.now())) {
          // Commands always get exactly one notice back, even when throttled.
          if (frame.op === "command")
            return replyNotice(ws, to, { code: "msg_ratelimit", text: "You are sending commands too quickly." });
          return replyError(ws, to, "rate_limited", "Too many requests.");
        }
        if (frame.op === "join") {
          const failure = await chat.join(ws, frame.channel.toLowerCase());
          if (failure) replyError(ws, to, failure.code, failure.message);
          return;
        }
        if (frame.op === "part") return chat.part(ws, frame.channel.toLowerCase());
        return replyNotice(
          ws,
          to,
          await chat.command(data.identity, frame.channel.toLowerCase(), frame.command, frame.args),
        );
      case "send":
        return handleSend(ws, frame, to);
    }
  };

  const handleSend = async (ws: ChatSocket, frame: Extract<ClientFrame, { op: "send" }>, to: Reply): Promise<void> => {
    metrics.messageIn();
    const slug = frame.channel.toLowerCase();
    const ack = (id: string | null, held: boolean): void => {
      sendFrame(ws, { op: "ack", nonce: frame.nonce, id, held }, frameWriter);
    };
    const cmd = frame.isAction ? null : splitChatCommand(frame.body);
    if (cmd && cmd.name !== "me") {
      replyNotice(ws, to, await chat.command(ws.data.identity, slug, cmd.name, cmd.args));
      return ack(null, false);
    }
    const body = cmd ? cmd.args.join(" ").trim() : frame.body;
    if (!body) {
      replyNotice(ws, to, { code: "usage", text: "Usage: /me <text>" });
      return ack(null, false);
    }
    const r = await chat.submit(ws.data.identity, {
      channel: slug,
      body,
      isAction: frame.isAction || cmd !== null,
      replyToId: frame.replyToId ?? null,
    });
    if (r.notice) replyNotice(ws, to, r.notice);
    ack(r.id, r.held);
  };

  const onMessage = (ws: ChatSocket, raw: string | Buffer<ArrayBuffer>) => {
    const data = ws.data;
    data.lastSeen = Date.now();
    let frame: ClientFrame | null = null;
    if (typeof raw === "string") {
      try {
        const parsed = ClientFrame.safeParse(JSON.parse(raw));
        if (parsed.success) frame = parsed.data;
      } catch {
        frame = null;
      }
    }
    if (!frame) {
      metrics.dropped("bad_frame");
      sendFrame(ws, { op: "error", code: "bad_request", message: "Malformed frame." }, frameWriter);
      if (++data.errors > MAX_BAD_FRAMES) ws.close(CLOSE.tooManyErrors, "too many malformed frames");
      return;
    }
    const f = frame;
    const to = replyTo(f);
    if (data.pending >= MAX_PENDING_FRAMES) {
      if (f.op === "command") replyNotice(ws, to, { code: "msg_ratelimit", text: "Too many requests in flight." });
      else replyError(ws, to, "rate_limited", "Too many requests in flight.");
      return;
    }
    data.pending++;
    data.queue = data.queue
      .then(() => handleFrame(ws, f))
      .catch((err: unknown) => {
        logger.error("chat frame failed", { ...errorFields(err), op: f.op });
        if (f.op === "command") replyNotice(ws, to, { code: "msg_rejected", text: "The command failed. Try again." });
        else replyError(ws, to, "internal_error", "Something went wrong.");
      })
      .finally(() => {
        data.pending--;
      });
  };

  const closeAll = () => {
    draining = true;
    for (const ws of sockets) ws.close(CLOSE.restart, "server restarting");
    // Clients that never complete the close handshake would hold server.stop() open.
    setTimeout(() => {
      for (const ws of sockets) ws.terminate();
    }, 2_000).unref();
  };
  // Registered before runService's handlers so sockets are closing when it stops the server.
  process.once("SIGTERM", closeAll);
  process.once("SIGINT", closeAll);

  const sweeper = setInterval(
    () => {
      const cutoff = Date.now() - heartbeatMs * 2;
      const now = Date.now();
      for (const ws of sockets) {
        const exp = ws.data.identity.expiresAt;
        if (exp !== null && exp <= now) {
          expire(ws, "credentials expired");
          continue;
        }
        if (ws.data.lastSeen >= cutoff) continue;
        metrics.dropped("idle");
        ws.close(CLOSE.idle, "heartbeat timeout");
      }
    },
    Math.max(250, Math.min(1_000, Math.floor(heartbeatMs / 2))),
  );
  sweeper.unref();

  const service: RunningService<ConnData> = runService<ConnData>({
    name: "chat",
    port: opts.port,
    hostname: opts.hostname,
    logger,
    checks: {
      valkey: valkeyCheck(valkey),
      postgres: async () => {
        await opts.db.execute(sql`select 1`);
        if (!pool.warm) throw new Error("pool warming up");
      },
    },
    fetch: (req, server) => upgrade(req, server),
    websocket: {
      maxPayloadLength: 16 * 1024,
      backpressureLimit: frameWriter.maxBufferedBytes + 64 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        sockets.add(ws);
        metrics.connectionOpened(ws.data.identity.via);
        sendFrame(ws, { op: "welcome", sessionId: ws.data.sessionId, user: ws.data.user, heartbeatMs }, frameWriter);
      },
      message: onMessage,
      close(ws) {
        ws.data.closed = true;
        if (!sockets.delete(ws)) return;
        metrics.connectionClosed(ws.data.identity.via);
        void chat.partAll(ws).catch((err: unknown) => logger.warn("part on close failed", errorFields(err)));
      },
    },
    onShutdown: async () => {
      clearInterval(sweeper);
      stopLagWatch();
      pool.stop();
      await writer.close();
      for (const mw of middlewares)
        await mw
          .close?.()
          .catch((err: unknown) => logger.warn("plugin close failed", { ...errorFields(err), plugin: mw.name }));
      await filterRunner.close();
      await Promise.allSettled([subscriber.quit(), valkey.quit()]);
      await opts.onShutdown?.();
    },
  });

  type UpgradeStage = "authenticate" | "profile";
  type Prepared = { ok: true; identity: Identity; user: ConnData["user"] } | { ok: false; response: Response };

  /** Everything before `server.upgrade` that waits on something; `trace` says what is pending. */
  const prepareUpgrade = async (
    req: Request,
    trace: { stage: UpgradeStage; userId: string | null },
  ): Promise<Prepared> => {
    const result = await auth.authenticate(req);
    if (!result.ok) {
      // Codes only: never the token. Clients (the IRC gateway) cannot see why an upgrade failed.
      logger.info("upgrade refused", { status: result.status, error: result.error });
      return { ok: false, response: Response.json({ error: result.error }, { status: result.status }) };
    }
    let user: ConnData["user"] = null;
    if (result.identity.userId) {
      trace.stage = "profile";
      trace.userId = result.identity.userId;
      directory.invalidateProfile(result.identity.userId);
      const profile = await directory.profile(result.identity.userId);
      if (!profile || profile.deleted) {
        logger.info("upgrade refused", { status: 401, error: "unknown_user" });
        return { ok: false, response: Response.json({ error: "unknown_user" }, { status: 401 }) };
      }
      user = { id: profile.id, username: profile.username, displayName: profile.displayName };
    }
    return { ok: true, identity: result.identity, user };
  };

  async function upgrade(req: Request, server: Server<ConnData>): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    if (pathname !== "/ws") return Response.json({ error: "not_found" }, { status: 404 });
    if (draining) return Response.json({ error: "shutting_down" }, { status: 503 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return Response.json({ error: "websocket_required" }, { status: 426 });
    const started = performance.now();
    const trace: { stage: UpgradeStage; userId: string | null } = { stage: "authenticate", userId: null };
    let prepared: Prepared;
    try {
      prepared = await withDeadline(prepareUpgrade(req, trace), upgradeTimeoutMs);
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - started);
      if (!(err instanceof DeadlineError)) {
        logger.error("upgrade failed", { ...errorFields(err), stage: trace.stage, userId: trace.userId, elapsedMs });
        return Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "1" } });
      }
      // A dependency stopped answering: answer now so the client can retry, rather than hang.
      metrics.upgradeTimedOut(trace.stage);
      logger.warn("upgrade timed out", { stage: trace.stage, userId: trace.userId, elapsedMs });
      return Response.json({ error: "unavailable" }, { status: 503, headers: { "retry-after": "1" } });
    }
    const elapsedMs = Math.round(performance.now() - started);
    if (elapsedMs >= SLOW_UPGRADE_MS) logger.warn("upgrade slow", { userId: trace.userId, elapsedMs });
    if (!prepared.ok) return prepared.response;
    const now = Date.now();
    const data: ConnData = {
      sessionId: crypto.randomUUID(),
      identity: prepared.identity,
      user: prepared.user,
      rooms: new Map(),
      lastSeen: now,
      closed: false,
      bucket: { tokens: 20, updated: now },
      queue: Promise.resolve(),
      pending: 0,
      errors: 0,
    };
    if (server.upgrade(req, { data })) {
      logger.debug("upgrade accepted", { sessionId: data.sessionId, userId: trace.userId, elapsedMs });
      return undefined;
    }
    return Response.json({ error: "upgrade_failed" }, { status: 400 });
  }

  const wsUrl = new URL(service.url);
  wsUrl.protocol = "ws:";
  wsUrl.pathname = "/ws";

  return {
    url: service.url,
    wsUrl: wsUrl.toString(),
    connections: () => sockets.size,
    flush: () => writer.flush(),
    async stop() {
      process.removeListener("SIGTERM", closeAll);
      process.removeListener("SIGINT", closeAll);
      closeAll();
      await service.stop();
    },
  };
}

/**
 * Log a Valkey client's connection trouble and recovery (codes only: iovalkey errors can carry
 * command arguments). Repeated errors while disconnected are logged once per outage.
 */
function watchValkey(client: ValkeyClient, name: string, logger: Logger): void {
  let down = false;
  client.on("error", (err: unknown) => {
    if (down) return;
    down = true;
    logger.warn("valkey connection error", { ...errorFields(err), client: name });
  });
  client.on("reconnecting", () => {
    if (down) return;
    down = true;
    logger.warn("valkey connection lost; reconnecting", { client: name });
  });
  client.on("ready", () => {
    if (!down) return;
    down = false;
    logger.info("valkey reconnected", { client: name });
  });
}

async function initPlugins(
  middlewares: readonly MessageMiddleware[],
  deps: {
    chat: ChatCore;
    rooms: Rooms;
    bus: Bus;
    busPrefix: string;
    db: Database;
    valkey: ValkeyClient;
    logger: Logger;
  },
): Promise<void> {
  const { chat, rooms, bus, busPrefix, db, valkey, logger } = deps;
  const host: PluginHost = {
    logger,
    db,
    valkey,
    subscribe: (channel, handler) => bus.acquire(busPrefix + channel, handler),
    hostedChannels: () =>
      [...rooms.all()].filter((r) => r.members.size > 0).map((r) => ({ id: r.channelId, slug: r.slug })),
    async say({ channel, userId, body, isAction }) {
      const identity: Identity = {
        userId,
        scopes: ["chat:read", "chat:edit"],
        appId: null,
        via: "token",
        expiresAt: null,
        tokenHash: null,
      };
      const r = await chat.submit(
        identity,
        { channel, body, isAction: isAction ?? false, replyToId: null },
        { skipMiddleware: true },
      );
      return { id: r.id, notice: r.notice?.code ?? null };
    },
    async command({ channel, userId, command, args }) {
      const identity: Identity = {
        userId,
        scopes: ["chat:read", "chat:edit", MODERATE_SCOPE],
        appId: null,
        via: "token",
        expiresAt: null,
        tokenHash: null,
      };
      const n = await chat.command(identity, channel, command, args);
      return [n.code];
    },
  };
  for (const mw of middlewares) await mw.init?.(host);
}
