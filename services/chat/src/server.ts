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
import { createValkey, runService, valkeyCheck, type RunningService } from "@commonair/service";
import { authenticate } from "./auth.ts";
import { Bus } from "./bus.ts";
import { splitChatCommand } from "./commands.ts";
import { ChatCore } from "./core.ts";
import { Directory, type DirectoryOptions } from "./directory.ts";
import { type Limiter, ValkeyLimiter } from "./limiter.ts";
import { createMetrics } from "./metrics.ts";
import { MODERATE_SCOPE, Moderation } from "./moderation.ts";
import { dbErrorFields, MessageWriter, type WriterOptions } from "./persistence.ts";
import type { MessageMiddleware, PluginHost } from "./pipeline.ts";
import { plugins } from "./plugins/index.ts";
import { Rooms } from "./rooms.ts";
import { type ChatSocket, CLOSE, type ConnData, sendFrame, takeToken, type Writer } from "./socket.ts";
import type { Identity, Rejection } from "./types.ts";

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
const MAX_BAD_FRAMES = 20;

export async function startChatService(opts: ChatServiceOptions): Promise<ChatService> {
  const logger = opts.logger ?? createLogger({ service: "chat" });
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const metrics = createMetrics();
  const valkey = createValkey(opts.valkeyUrl, { keyPrefix: opts.keyPrefix, name: "chat" });
  const subscriber = createValkey(opts.valkeyUrl, { name: "chat-sub" });
  const bus = new Bus(valkey, subscriber, opts.busPrefix ?? "", logger);
  const directory = new Directory(opts.db, {
    onInvalidFilter: (channelId, filterId) => logger.warn("invalid word filter skipped", { channelId, filterId }),
    ...opts.directory,
  });
  const writer = new MessageWriter(opts.db, logger, metrics, opts.writer);
  const frameWriter: Writer = { maxBufferedBytes: opts.maxBufferedBytes ?? 1024 * 1024, metrics };
  const middlewares = opts.middlewares ?? plugins;
  const sockets = new Set<ChatSocket>();
  let draining = false;

  // `core` is assigned right below; room handlers only fire after a join, which needs it.
  let core: ChatCore | undefined;
  const rooms = new Rooms(
    bus,
    { onChat: (id, raw) => core?.onChat(id, raw), onControl: (id, raw) => core?.onControl(id, raw) },
    frameWriter,
  );
  const moderation = new Moderation({
    db: opts.db,
    directory,
    publishControl: (channelId, message) => bus.publish(bus.names.control(channelId), JSON.stringify(message)),
    flushMessages: () => writer.flush(),
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
  });
  core = chat;

  await Promise.all([
    bus.acquire(bus.names.events(), (raw) => chat.onEvent(raw)),
    bus.acquire(bus.names.live(), (raw) => chat.onLive(raw)),
  ]);
  await initPlugins(middlewares, chat, logger);

  const handleFrame = async (ws: ChatSocket, frame: ClientFrame): Promise<void> => {
    const data = ws.data;
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
            return replyNotice(ws, frame.channel, {
              code: "msg_ratelimit",
              text: "You are sending commands too quickly.",
            });
          sendFrame(ws, { op: "error", code: "rate_limited", message: "Too many requests." }, frameWriter);
          return;
        }
        if (frame.op === "join") return chat.join(ws, frame.channel.toLowerCase());
        if (frame.op === "part") return chat.part(ws, frame.channel.toLowerCase());
        return replyNotice(
          ws,
          frame.channel,
          await chat.command(data.identity, frame.channel.toLowerCase(), frame.command, frame.args),
        );
      case "send":
        return handleSend(ws, frame);
    }
  };

  const replyNotice = (ws: ChatSocket, channel: string | null, n: Rejection | null) => {
    if (n)
      sendFrame(ws, { op: "notice", channel: channel?.toLowerCase() ?? null, code: n.code, text: n.text }, frameWriter);
  };

  const handleSend = async (ws: ChatSocket, frame: Extract<ClientFrame, { op: "send" }>): Promise<void> => {
    metrics.messageIn();
    const slug = frame.channel.toLowerCase();
    const cmd = frame.isAction ? null : splitChatCommand(frame.body);
    if (cmd && cmd.name !== "me") {
      replyNotice(ws, slug, await chat.command(ws.data.identity, slug, cmd.name, cmd.args));
      sendFrame(ws, { op: "ack", nonce: frame.nonce, id: null, held: false }, frameWriter);
      return;
    }
    const body = cmd ? cmd.args.join(" ").trim() : frame.body;
    if (!body) {
      replyNotice(ws, slug, { code: "unrecognized_cmd", text: "Usage: /me <text>" });
      sendFrame(ws, { op: "ack", nonce: frame.nonce, id: null, held: false }, frameWriter);
      return;
    }
    const r = await chat.submit(ws.data.identity, {
      channel: slug,
      body,
      isAction: frame.isAction || cmd !== null,
      replyToId: frame.replyToId ?? null,
    });
    replyNotice(ws, slug, r.notice);
    sendFrame(ws, { op: "ack", nonce: frame.nonce, id: r.id, held: r.held }, frameWriter);
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
    if (data.pending >= MAX_PENDING_FRAMES) {
      sendFrame(ws, { op: "error", code: "rate_limited", message: "Too many requests in flight." }, frameWriter);
      return;
    }
    const f = frame;
    data.pending++;
    data.queue = data.queue
      .then(() => handleFrame(ws, f))
      .catch((err: unknown) => {
        logger.error("chat frame failed", { ...dbErrorFields(err), op: f.op });
        if (f.op === "command")
          replyNotice(ws, f.channel, { code: "msg_rejected", text: "The command failed. Try again." });
        else sendFrame(ws, { op: "error", code: "internal_error", message: "Something went wrong." }, frameWriter);
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
      for (const ws of sockets) {
        if (ws.data.lastSeen >= cutoff) continue;
        metrics.dropped("idle");
        ws.close(CLOSE.idle, "heartbeat timeout");
      }
    },
    Math.max(250, Math.floor(heartbeatMs / 2)),
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
        void chat.partAll(ws).catch((err: unknown) => logger.warn("part on close failed", { err }));
      },
    },
    onShutdown: async () => {
      clearInterval(sweeper);
      await writer.close();
      for (const mw of middlewares)
        await mw.close?.().catch((err: unknown) => logger.warn("plugin close failed", { err, plugin: mw.name }));
      await Promise.allSettled([subscriber.quit(), valkey.quit()]);
      await opts.onShutdown?.();
    },
  });

  async function upgrade(req: Request, server: Server<ConnData>): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    if (pathname !== "/ws") return Response.json({ error: "not_found" }, { status: 404 });
    if (draining) return Response.json({ error: "shutting_down" }, { status: 503 });
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return Response.json({ error: "websocket_required" }, { status: 426 });
    const auth = await authenticate(req, opts.db, opts.internalSecret);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
    let user: ConnData["user"] = null;
    if (auth.identity.userId) {
      directory.invalidateProfile(auth.identity.userId);
      const profile = await directory.profile(auth.identity.userId);
      if (!profile || profile.deleted) return Response.json({ error: "unknown_user" }, { status: 401 });
      user = { id: profile.id, username: profile.username, displayName: profile.displayName };
    }
    const now = Date.now();
    const data: ConnData = {
      sessionId: crypto.randomUUID(),
      identity: auth.identity,
      user,
      rooms: new Map(),
      lastSeen: now,
      closed: false,
      bucket: { tokens: 20, updated: now },
      queue: Promise.resolve(),
      pending: 0,
      errors: 0,
    };
    if (server.upgrade(req, { data })) return undefined;
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

async function initPlugins(middlewares: readonly MessageMiddleware[], chat: ChatCore, logger: Logger): Promise<void> {
  const host: PluginHost = {
    logger,
    async say({ channel, userId, body, isAction }) {
      const identity: Identity = { userId, scopes: ["chat:read", "chat:edit"], appId: null, via: "token" };
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
      };
      const n = await chat.command(identity, channel, command, args);
      return [n.code];
    },
  };
  for (const mw of middlewares) await mw.init?.(host);
}
