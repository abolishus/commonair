// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The gateway: starts the TCP, TLS and WebSocket listeners, tracks sessions,
 * and shuts down gracefully (RECONNECT, then close) so clients move to another
 * instance without losing more than a moment of chat.
 */
import type { Logger } from "@commonair/observability";
import { meter } from "@commonair/observability";
import { Admission, DEFAULT_CONNECTION_LIMITS, REFUSAL_TEXT, type ConnectionLimits } from "./admission.ts";
import { LIMITS } from "./constants.ts";
import type { Cidr } from "./net.ts";
import { listenSocket, listenWebSocket, type Accept } from "./listeners.ts";
import { IrcSession, type SessionLimits, type TransportKind } from "./session.ts";
import type { TlsMaterial } from "./tls.ts";
import type { UpstreamFactory } from "./upstream.ts";

export interface GatewayOptions {
  hostname?: string;
  /** Ports; 0 picks a free port. `null` disables a listener. */
  tcpPort: number | null;
  tlsPort: number | null;
  wsPort: number | null;
  /**
   * Listening sockets inherited from systemd (socket activation). When set, the TCP/TLS
   * listener accepts on that descriptor and its port is only reported, not bound.
   */
  inherited?: { tcp: number; tls: number } | undefined;
  tls?: TlsMaterial | undefined;
  upstream: UpstreamFactory;
  logger: Logger;
  motd: string;
  limits?: Partial<SessionLimits>;
  connectionLimits?: Partial<ConnectionLimits>;
  /** Proxies whose X-Forwarded-For is believed for WebSocket clients (TRUSTED_PROXY_CIDRS). */
  trustedProxies?: readonly Cidr[];
}

export interface GatewayStats {
  connections: Record<TransportKind, number>;
  total: number;
  registered: number;
  channels: number;
  limits: ConnectionLimits;
}

export interface Gateway {
  ports: { tcp: number | null; tls: number | null; ws: number | null };
  stats(): GatewayStats;
  /** Send RECONNECT, wait up to `graceMs` for clients to leave, then close the rest. */
  shutdown(graceMs?: number): Promise<void>;
}

export function startGateway(opts: GatewayOptions): Gateway {
  const hostname = opts.hostname ?? "0.0.0.0";
  const sessions = new Set<IrcSession>();
  const maxFrameBytes = opts.limits?.maxFrameBytes ?? LIMITS.maxFrameBytes;
  const opened = meter("irc").createCounter("irc.connections.opened");
  let accepting = true;

  const refused = meter("irc").createCounter("irc.connections.refused");
  const admission = new Admission({ ...DEFAULT_CONNECTION_LIMITS, ...opts.connectionLimits });

  const accept: Accept = (transport, address) => {
    const refusal = accepting ? admission.admit(address) : "server_full";
    if (refusal !== null) {
      refused.add(1, { reason: refusal });
      transport.write([`ERROR :Closing Link: ${accepting ? REFUSAL_TEXT[refusal] : "Server shutting down"}`]);
      transport.close();
      return null;
    }
    const session = new IrcSession(transport, {
      upstream: opts.upstream,
      logger: opts.logger,
      motd: opts.motd,
      limits: opts.limits,
      onClosed: (s) => {
        sessions.delete(s);
        admission.release(address);
      },
    });
    sessions.add(session);
    opened.add(1, { transport: transport.kind });
    return session;
  };

  const at = (port: number, fd: number | undefined) => (fd === undefined ? { hostname, port } : { fd });
  const tcp =
    opts.tcpPort === null
      ? null
      : listenSocket({ kind: "tcp", ...at(opts.tcpPort, opts.inherited?.tcp), maxFrameBytes, accept });
  const tls =
    opts.tlsPort === null || !opts.tls
      ? null
      : listenSocket({ kind: "tls", ...at(opts.tlsPort, opts.inherited?.tls), maxFrameBytes, tls: opts.tls, accept });
  const ws =
    opts.wsPort === null
      ? null
      : listenWebSocket({ hostname, port: opts.wsPort, maxFrameBytes, trustedProxies: opts.trustedProxies, accept });

  const stats = (): GatewayStats => {
    const connections: Record<TransportKind, number> = { tcp: 0, tls: 0, ws: 0 };
    let registered = 0;
    let channels = 0;
    for (const s of sessions) {
      connections[s.transportKind]++;
      if (s.registered) registered++;
      channels += s.channelCount;
    }
    return { connections, total: sessions.size, registered, channels, limits: admission.limits };
  };

  meter("irc")
    .createObservableGauge("irc.connections")
    .addCallback((r) => {
      for (const [transport, n] of Object.entries(stats().connections)) r.observe(n, { transport });
    });

  // A listener on an inherited descriptor has no port of its own: report the configured one.
  const ports = {
    tcp: tcp ? (tcp.port ?? opts.tcpPort) : null,
    tls: tls ? (tls.port ?? opts.tlsPort) : null,
    ws: ws?.port ?? null,
  };
  opts.logger.info("irc gateway listening", { ...ports, socketActivated: opts.inherited !== undefined });

  return {
    ports,
    stats,
    async shutdown(graceMs = 3000) {
      if (!accepting) return;
      accepting = false;
      tcp?.stop(false);
      tls?.stop(false);
      void ws?.stop(false);
      for (const s of sessions) s.announceReconnect();
      const deadline = Date.now() + graceMs;
      while (sessions.size > 0 && Date.now() < deadline) await Bun.sleep(50);
      for (const s of sessions) s.close("Server shutting down", true);
      // Let the final ERROR lines flush before the listeners drop their sockets.
      await Bun.sleep(100);
      tcp?.stop(true);
      tls?.stop(true);
      await ws?.stop(true);
      admission.stop();
    },
  };
}
