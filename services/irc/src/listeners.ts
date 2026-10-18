// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transports: plain TCP, TLS, and IRC-over-WebSocket. Each adapts its socket to
 * the session's `Transport` interface and feeds it lines.
 */
import type { Server, ServerWebSocket, Socket, TCPSocketListener } from "bun";
import { LineFramer, splitFrame, type FramerSink } from "./irc/framer.ts";
import { clientAddress, type Cidr } from "./net.ts";
import type { Transport, TransportKind } from "./session.ts";

const encoder = new TextEncoder();
/** After close(), give a client this long to take queued output before the socket is torn down. */
const CLOSE_FLUSH_MS = 5000;

export interface SessionSink extends FramerSink {
  transportClosed(): void;
}

/**
 * Admits a new connection from `address` (already resolved through trusted proxies)
 * and returns its line sink, or null when the gateway refused it (it has then
 * written the ERROR line and closed the transport).
 */
export type Accept = (transport: Transport, address: string) => SessionSink | null;

// ------------------------------------------------------------ TCP / TLS

interface SocketState {
  sink: SessionSink | null;
  framer: LineFramer | null;
  pending: Uint8Array[];
  pendingBytes: number;
  closing: boolean;
}

function socketTransport(kind: TransportKind, socket: Socket<SocketState>): Transport {
  const st = socket.data;
  const endIfDrained = () => {
    if (st.closing && st.pendingBytes === 0) socket.end();
  };
  return {
    kind,
    write(lines) {
      if (st.closing) return;
      const bytes = encoder.encode(`${lines.join("\r\n")}\r\n`);
      if (st.pendingBytes > 0) {
        st.pending.push(bytes);
        st.pendingBytes += bytes.length;
        return;
      }
      const n = socket.write(bytes);
      if (n < bytes.length) {
        const rest = bytes.subarray(Math.max(0, n));
        st.pending.push(rest);
        st.pendingBytes += rest.length;
      }
    },
    bufferedBytes: () => st.pendingBytes,
    close() {
      if (st.closing) return;
      st.closing = true;
      endIfDrained();
      if (st.pendingBytes > 0) setTimeout(() => socket.terminate(), CLOSE_FLUSH_MS).unref();
    },
  };
}

function drain(socket: Socket<SocketState>): void {
  const st = socket.data;
  while (st.pending.length > 0) {
    const head = st.pending[0];
    if (!head) break;
    const n = socket.write(head);
    if (n < head.length) {
      st.pending[0] = head.subarray(Math.max(0, n));
      st.pendingBytes -= Math.max(0, n);
      return;
    }
    st.pending.shift();
    st.pendingBytes -= head.length;
  }
  if (st.closing) socket.end();
}

export function listenSocket(opts: {
  kind: "tcp" | "tls";
  hostname: string;
  port: number;
  maxFrameBytes: number;
  tls?: { cert: string; key: string } | undefined;
  accept: Accept;
}): TCPSocketListener<SocketState> {
  return Bun.listen<SocketState>({
    hostname: opts.hostname,
    port: opts.port,
    ...(opts.tls ? { tls: opts.tls } : {}),
    socket: {
      open(socket) {
        socket.data = { sink: null, framer: null, pending: [], pendingBytes: 0, closing: false };
        // No PROXY protocol support: a TCP/TLS peer address is always the client's own.
        const sink = opts.accept(socketTransport(opts.kind, socket), clientAddress(socket.remoteAddress, null, []));
        if (!sink) return;
        socket.data.sink = sink;
        socket.data.framer = new LineFramer(opts.maxFrameBytes, sink);
      },
      data(socket, chunk) {
        if (!socket.data.closing) socket.data.framer?.push(chunk);
      },
      drain,
      close(socket) {
        socket.data.sink?.transportClosed();
      },
      error(socket) {
        socket.data.sink?.transportClosed();
      },
    },
  });
}

// ------------------------------------------------------------ WebSocket

/** IRCv3 WebSocket subprotocols, plus `irc` which tmi.js requests. */
const SUBPROTOCOLS = ["irc", "text.ircv3.net", "binary.ircv3.net"] as const;
type Subprotocol = (typeof SUBPROTOCOLS)[number] | null;

interface WsState {
  protocol: Subprotocol;
  address: string;
  sink: SessionSink | null;
}

function wsTransport(ws: ServerWebSocket<WsState>): Transport {
  const proto = ws.data.protocol;
  let closed = false;
  return {
    kind: "ws",
    write(lines) {
      if (closed) return;
      // The IRCv3 subprotocols carry exactly one line per frame; plain/`irc` clients (tmi.js) accept batches.
      if (proto === "binary.ircv3.net") for (const l of lines) ws.sendBinary(encoder.encode(l));
      else if (proto === "text.ircv3.net") for (const l of lines) ws.sendText(l);
      else ws.sendText(`${lines.join("\r\n")}\r\n`);
    },
    bufferedBytes: () => ws.getBufferedAmount(),
    close() {
      if (closed) return;
      closed = true;
      ws.close(1000);
    },
  };
}

export function listenWebSocket(opts: {
  hostname: string;
  port: number;
  maxFrameBytes: number;
  /** Peers whose X-Forwarded-For is believed (TRUSTED_PROXY_CIDRS). */
  trustedProxies?: readonly Cidr[];
  accept: Accept;
}): Server<WsState> {
  return Bun.serve<WsState>({
    hostname: opts.hostname,
    port: opts.port,
    fetch(req, server) {
      if (new URL(req.url).pathname !== "/") return new Response("not found", { status: 404 });
      const offered = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const protocol = SUBPROTOCOLS.find((p) => offered.includes(p)) ?? null;
      if (offered.length > 0 && protocol === null) return new Response("unsupported subprotocol", { status: 400 });
      const peer = server.requestIP(req)?.address ?? "";
      const address = clientAddress(peer, req.headers.get("x-forwarded-for"), opts.trustedProxies ?? []);
      const data: WsState = { protocol, address, sink: null };
      // Bun fails the upgrade with a 500 when given an empty headers object, so pass one only to echo a protocol.
      const upgraded = protocol
        ? server.upgrade(req, { data, headers: { "Sec-WebSocket-Protocol": protocol } })
        : server.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      // Several lines per frame are allowed, so a frame may exceed one line's cap.
      maxPayloadLength: opts.maxFrameBytes * 4,
      idleTimeout: 0, // the session runs its own PING/timeout logic
      open(ws) {
        ws.data.sink = opts.accept(wsTransport(ws), ws.data.address);
      },
      message(ws, message) {
        const sink = ws.data.sink;
        if (!sink) return;
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        splitFrame(text, opts.maxFrameBytes, sink);
      },
      close(ws) {
        ws.data.sink?.transportClosed();
      },
    },
  });
}
