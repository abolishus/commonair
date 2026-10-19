// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The tracker service: WebSocket upgrades (authenticated by the playback token), per-socket
 * limits, the swarm registry and evidence writes. Upgrades are accepted on any path because
 * Caddy strips the `/tracker` prefix; `/healthz` and `/readyz` belong to runService.
 */
import type { Server, ServerWebSocket } from "bun";
import { KEYS } from "@commonair/contracts/internal";
import { meter, type Logger } from "@commonair/observability";
import { runService, valkeyCheck, type RunningService, type ValkeyClient } from "@commonair/service";
import { heartbeatFresh, verifyTrackerToken } from "./auth.ts";
import { Evidence } from "./evidence.ts";
import { PendingExchanges } from "./exchanges.ts";
import { canonicalIp, clientIp } from "./ip.ts";
import { LIMITS, parseFrame } from "./protocol.ts";
import { TokenBucket } from "./ratelimit.ts";
import { SwarmRegistry, type Conn } from "./swarm.ts";

export interface TrackerLimits {
  maxConnections: number;
  maxConnectionsPerIp: number;
  maxNumwant: number;
  tokenMaxAgeSeconds: number;
}

export interface TrackerOptions {
  port: number;
  hostname?: string;
  logger: Logger;
  valkey: ValkeyClient;
  /** Playback verify key (derived from PLAYBACK_SIGNING_KEY). */
  publicKey: CryptoKey;
  /** INTERNAL_API_SECRET: keys the network HMAC. */
  internalSecret: string;
  /** TRUSTED_PROXY_CIDRS. */
  trustedProxies: readonly string[];
  limits: TrackerLimits;
  /** How often an announcing socket's heartbeat is re-checked (default 30 s). */
  heartbeatRecheckMs?: number;
  /** Rate limit override (tests). */
  rate?: { burst: number; perSecond: number };
  now?: () => number;
  random?: () => number;
  onShutdown?: () => Promise<void>;
}

interface SocketData extends Conn {
  sid: string;
  channelId: string;
  /** The token's `iat`: a socket with a newer one for the same session replaces this one. */
  iat: number;
  ip: string;
  net: Promise<string>;
  bucket: TokenBucket;
  swarms: Map<string, string>;
  lastHeartbeatCheck: number;
  queue: Promise<void>;
  closed: boolean;
  ws: ServerWebSocket<SocketData> | null;
  send(msg: object): void;
}

export interface TrackerStats {
  connections: number;
  swarms: number;
  announces: number;
  offersRelayed: number;
  answersRelayed: number;
  exchanges: number;
  replaced: number;
  evidenceFailures: number;
  refused: Record<string, number>;
}

export interface Tracker {
  service: RunningService<SocketData>;
  url: URL;
  stats(): TrackerStats;
  stop(): Promise<void>;
}

const HEARTBEAT_RECHECK_MS = 30_000;

export function startTracker(opts: TrackerOptions): Tracker {
  const { logger, valkey } = opts;
  const now = opts.now ?? Date.now;
  const recheckMs = opts.heartbeatRecheckMs ?? HEARTBEAT_RECHECK_MS;
  const rate = opts.rate ?? { burst: LIMITS.rateBurst, perSecond: LIMITS.ratePerSecond };
  const evidence = new Evidence(valkey, opts.internalSecret);

  const m = meter("tracker");
  const metrics = {
    opened: m.createCounter("tracker.connections.opened"),
    closed: m.createCounter("tracker.connections.closed"),
    refused: m.createCounter("tracker.upgrades.refused"),
    frameErrors: m.createCounter("tracker.frames.refused"),
    announces: m.createCounter("tracker.announces"),
    offers: m.createCounter("tracker.offers.relayed"),
    answers: m.createCounter("tracker.answers.relayed"),
    exchanges: m.createCounter("tracker.exchanges.completed"),
    replaced: m.createCounter("tracker.connections.replaced"),
    swarms: m.createUpDownCounter("tracker.swarms"),
    evidenceFailures: m.createCounter("tracker.evidence.failures"),
  };
  const stats: TrackerStats = {
    connections: 0,
    swarms: 0,
    announces: 0,
    offersRelayed: 0,
    answersRelayed: 0,
    exchanges: 0,
    replaced: 0,
    evidenceFailures: 0,
    refused: {},
  };

  const registry = new SwarmRegistry({
    maxNumwant: opts.limits.maxNumwant,
    random: opts.random,
    now,
    onSwarmCount: (d) => {
      stats.swarms += d;
      metrics.swarms.add(d);
    },
  });

  /** Connection slots per canonical client address, held from upgrade start until close. */
  const perIp = new Map<string, number>();
  let slots = 0;
  /** Session id → its open socket. */
  const sessions = new Map<string, SocketData>();
  /** Session ids whose upgrade is between its checks and `open`. */
  const upgrading = new Set<string>();
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const release = (ip: string) => {
    slots--;
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  };
  const refuse = (status: number, reason: string) => {
    stats.refused[reason] = (stats.refused[reason] ?? 0) + 1;
    metrics.refused.add(1, { reason });
    logger.debug("upgrade refused", { reason });
    return Response.json({ error: reason }, { status });
  };
  const evidenceFailed = (err: unknown) => {
    stats.evidenceFailures++;
    metrics.evidenceFailures.add(1);
    logger.warn("p2p evidence write failed", { err: err instanceof Error ? err.message : String(err) });
  };

  async function upgrade(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return Response.json({ error: "upgrade_required" }, { status: 426 });
    const socketIp = server.requestIP(req)?.address ?? "0.0.0.0";
    const ip = canonicalIp(clientIp(socketIp, req.headers.get("x-forwarded-for"), opts.trustedProxies));
    if (slots >= opts.limits.maxConnections) return refuse(503, "capacity");
    if ((perIp.get(ip) ?? 0) >= opts.limits.maxConnectionsPerIp) return refuse(429, "ip_limit");
    // Hold the slot through the async checks so concurrent upgrades cannot overshoot the limits.
    slots++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let upgraded = false;
    try {
      const token = new URL(req.url).searchParams.get("t");
      const v = await verifyTrackerToken(
        opts.publicKey,
        token,
        Math.floor(now() / 1000),
        opts.limits.tokenMaxAgeSeconds,
      );
      if (!v.ok) return refuse(401, `token_${v.error}`);
      const { sid, cid, iat } = v.claims;
      // One socket per session; a newer token takes the slot over (ADR 0005), so a leaked
      // token cannot lock the honest viewer out beyond its next refresh.
      const taken = () => upgrading.has(sid) || (sessions.get(sid)?.iat ?? -Infinity) >= iat;
      if (taken()) return refuse(409, "duplicate_session");
      let score: string | null;
      try {
        score = await valkey.zscore(KEYS.viewers(cid), sid);
      } catch (err) {
        logger.warn("heartbeat lookup failed", { err: err instanceof Error ? err.message : String(err) });
        return refuse(503, "unavailable");
      }
      if (!heartbeatFresh(score, now())) return refuse(401, "not_watching");
      if (taken()) return refuse(409, "duplicate_session");

      const data: SocketData = {
        sid,
        channelId: cid,
        iat,
        pending: new PendingExchanges(),
        ip,
        net: evidence.networkHash(ip),
        bucket: new TokenBucket(rate.burst, rate.perSecond, now()),
        swarms: new Map(),
        lastHeartbeatCheck: now(),
        queue: Promise.resolve(),
        closed: false,
        ws: null,
        send(msg) {
          if (!this.closed) this.ws?.send(JSON.stringify(msg));
        },
      };
      upgrading.add(sid);
      upgraded = server.upgrade(req, { data });
      if (!upgraded) {
        upgrading.delete(sid);
        return refuse(400, "bad_upgrade");
      }
      return undefined;
    } finally {
      if (!upgraded) release(ip);
    }
  }

  const frameError = (d: SocketData, reason: string, infoHash?: string) => {
    metrics.frameErrors.add(1, { reason });
    d.send(infoHash === undefined ? { "failure reason": reason } : { "failure reason": reason, info_hash: infoHash });
  };

  async function handleText(ws: ServerWebSocket<SocketData>, text: string): Promise<void> {
    const d = ws.data;
    if (d.closed) return;
    const parsed = parseFrame(text);
    if (!parsed.ok) return frameError(d, parsed.reason, parsed.infoHash);
    const frame = parsed.frame;

    if (frame.action === "announce" && frame.event !== "stopped" && now() - d.lastHeartbeatCheck >= recheckMs) {
      let fresh = true;
      try {
        fresh = heartbeatFresh(await valkey.zscore(KEYS.viewers(d.channelId), d.sid), now());
      } catch (err) {
        // Valkey trouble never drops signalling; the next announce re-checks.
        logger.warn("heartbeat re-check failed", { err: err instanceof Error ? err.message : String(err) });
      }
      if (!fresh) {
        ws.close(1008, "session not watching");
        return;
      }
      d.lastHeartbeatCheck = now();
      if (d.closed) return;
    }

    const outcome = registry.handle(d, frame);
    if (outcome.kind === "refused") {
      metrics.frameErrors.add(1, { reason: outcome.reason });
      return;
    }
    if (outcome.kind === "stopped") {
      evidence.forget(d.sid, [outcome.swarm]).catch(evidenceFailed);
      return;
    }
    if (outcome.kind !== "announce") return;
    stats.announces++;
    metrics.announces.add(1);
    if (outcome.offersRelayed) {
      stats.offersRelayed += outcome.offersRelayed;
      metrics.offers.add(outcome.offersRelayed);
    }
    if (outcome.answerRelayed) {
      stats.answersRelayed++;
      metrics.answers.add(1);
    }
    const at = now();
    d.net.then((net) => evidence.record(d.sid, outcome.swarm, net, at)).catch(evidenceFailed);
    const offerer = outcome.exchange as SocketData | null;
    if (offerer) {
      stats.exchanges++;
      metrics.exchanges.add(1);
      Promise.all([offerer.net, d.net])
        .then(([offererNet, net]) => evidence.link({ sid: offerer.sid, net: offererNet }, { sid: d.sid, net }, at))
        .catch(evidenceFailed);
    }
  }

  /** Socket teardown, run once: on close, or at once when a newer socket replaces it. */
  function teardown(d: SocketData): void {
    if (d.closed) return;
    d.closed = true;
    if (d.ws) sockets.delete(d.ws);
    stats.connections--;
    metrics.closed.add(1);
    if (sessions.get(d.sid) === d) sessions.delete(d.sid);
    release(d.ip);
    const left = registry.leaveAll(d);
    // A replacing socket of the same session may already be in some of these swarms.
    const current = sessions.get(d.sid);
    evidence.forget(d.sid, current ? left.filter((s) => !current.swarms.has(s)) : left).catch(evidenceFailed);
  }

  const service = runService<SocketData>({
    name: "tracker",
    port: opts.port,
    hostname: opts.hostname,
    logger,
    checks: { valkey: valkeyCheck(valkey) },
    fetch: (req, server) => upgrade(req, server),
    websocket: {
      maxPayloadLength: LIMITS.maxFrameBytes,
      idleTimeout: LIMITS.idleTimeoutSeconds,
      perMessageDeflate: false,
      open(ws) {
        ws.data.ws = ws;
        upgrading.delete(ws.data.sid);
        const old = sessions.get(ws.data.sid);
        sessions.set(ws.data.sid, ws.data);
        if (old) {
          // Leave the swarms now so the new socket can reclaim the same peer ids.
          teardown(old);
          old.ws?.close(1008, "replaced by a newer connection");
          stats.replaced++;
          metrics.replaced.add(1);
        }
        sockets.add(ws);
        stats.connections++;
        metrics.opened.add(1);
      },
      message(ws, msg) {
        const d = ws.data;
        if (typeof msg !== "string") {
          ws.close(1003, "text frames only");
          return;
        }
        if (!d.bucket.take(now())) {
          metrics.frameErrors.add(1, { reason: "rate_limited" });
          ws.close(1008, "rate limited");
          return;
        }
        d.queue = d.queue
          .then(() => handleText(ws, msg))
          .catch((err: unknown) => logger.error("frame handling failed", { err }));
      },
      close(ws) {
        teardown(ws.data);
      },
    },
    onShutdown: async () => {
      await opts.onShutdown?.();
    },
  });

  // runService stops the listener on SIGTERM; open sockets must be told to go too.
  const closeAll = () => {
    for (const ws of sockets) ws.close(1001, "server shutting down");
  };
  process.on("SIGTERM", closeAll);
  process.on("SIGINT", closeAll);

  return {
    service,
    url: service.url,
    stats: () => ({ ...stats, refused: { ...stats.refused } }),
    stop: async () => {
      process.off("SIGTERM", closeAll);
      process.off("SIGINT", closeAll);
      closeAll();
      await service.stop();
    },
  };
}
