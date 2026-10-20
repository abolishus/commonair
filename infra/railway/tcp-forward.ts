// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Plain TCP forwarder for WebRTC ICE-TCP on Railway (`webrtc-tcp` in .railway/railway.ts).
 *
 * Railway has no public UDP, only TCP proxies, and a proxy's public port is assigned by Railway
 * and differs from the container port it targets. MediaMTX advertises its ICE-TCP candidate with
 * the port it listens on, so it must listen on the *public* port. This service owns the TCP proxy
 * (public port P → container port LISTEN_PORT) and forwards every connection to MediaMTX on P over
 * the private network; MediaMTX then advertises `<proxy host>:P`, which is what clients dial.
 * ICE-TCP is RFC 4571 framed STUN/DTLS/SRTP and MediaMTX demultiplexes sessions by ICE username,
 * so a byte-transparent forwarder is enough.
 *
 *   LISTEN_PORT=8189 TARGET_HOST=mediamtx.railway.internal TARGET_PORT=<P> bun infra/railway/tcp-forward.ts
 */
import type { Socket, TCPSocketListener } from "bun";

/** Bytes buffered toward one slow side before the pair is dropped (a few seconds of 1080p60). */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export interface ForwarderOptions {
  listenHost?: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  maxQueuedBytes?: number;
}

/** One direction of a connection: bytes waiting for `to` to accept them. */
class Pipe {
  to: Socket<Conn> | undefined;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private ending = false;

  constructor(private readonly max: number) {}

  /** False when the backlog exceeds the cap and the connection should be dropped. */
  send(chunk: Uint8Array): boolean {
    if (this.to && this.queue.length === 0) {
      const n = this.to.write(chunk);
      if (n >= chunk.byteLength) return true;
      chunk = chunk.subarray(n);
    }
    // Bun may reuse the read buffer after the data callback returns.
    this.queue.push(new Uint8Array(chunk));
    this.queued += chunk.byteLength;
    return this.queued <= this.max;
  }

  flush(): void {
    const to = this.to;
    if (!to) return;
    while (this.queue.length > 0) {
      const head = this.queue[0] as Uint8Array;
      const n = to.write(head);
      this.queued -= Math.max(n, 0);
      if (n < head.byteLength) {
        this.queue[0] = head.subarray(Math.max(n, 0));
        return;
      }
      this.queue.shift();
    }
    if (this.ending) to.end();
  }

  /** The source closed: end the destination once what is buffered has been written. */
  end(): void {
    this.ending = true;
    if (this.to && this.queue.length === 0) this.to.end();
  }
}

interface Conn {
  /** Bytes flowing into this socket. */
  inbound: Pipe;
  /** Bytes flowing out of this socket to its peer. */
  outbound: Pipe;
  peer?: Socket<Conn>;
  closed?: boolean;
}

export function startForwarder(opts: ForwarderOptions): TCPSocketListener<Conn> {
  const max = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const drop = (s: Socket<Conn>) => {
    s.data.peer?.terminate();
    s.terminate();
  };

  const upstream = {
    data(s: Socket<Conn>, chunk: Uint8Array) {
      if (!s.data.outbound.send(chunk)) drop(s);
    },
    drain(s: Socket<Conn>) {
      s.data.inbound.flush();
    },
    close(s: Socket<Conn>) {
      s.data.outbound.end();
    },
    error(s: Socket<Conn>) {
      drop(s);
    },
  };

  return Bun.listen<Conn>({
    hostname: opts.listenHost ?? "0.0.0.0",
    port: opts.listenPort,
    socket: {
      open(client) {
        const toTarget = new Pipe(max);
        const toClient = new Pipe(max);
        toClient.to = client;
        client.data = { inbound: toClient, outbound: toTarget };
        Bun.connect<Conn>({
          hostname: opts.targetHost,
          port: opts.targetPort,
          data: { inbound: toTarget, outbound: toClient, peer: client },
          socket: upstream,
        }).then(
          (target) => {
            if (client.data.closed) {
              target.terminate();
              return;
            }
            client.data.peer = target;
            toTarget.to = target;
            toTarget.flush();
          },
          () => client.terminate(),
        );
      },
      data(client, chunk) {
        if (!client.data.outbound.send(chunk)) drop(client);
      },
      drain(client) {
        client.data.inbound.flush();
      },
      close(client) {
        client.data.closed = true;
        client.data.outbound.end();
      },
      error(client) {
        client.data.closed = true;
        drop(client);
      },
    },
  });
}

function port(name: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a TCP port, got "${value ?? ""}"`);
  return n;
}

if (import.meta.main) {
  try {
    const targetHost = process.env.TARGET_HOST;
    if (!targetHost) throw new Error("TARGET_HOST is required");
    const opts = {
      listenPort: port("LISTEN_PORT", process.env.LISTEN_PORT ?? "8189"),
      targetHost,
      targetPort: port("TARGET_PORT", process.env.TARGET_PORT),
    };
    startForwarder(opts);
    process.stdout.write(`tcp-forward: :${opts.listenPort} → ${opts.targetHost}:${opts.targetPort}\n`);
  } catch (e) {
    console.error(`tcp-forward: ${(e as Error).message}`);
    process.exit(1);
  }
}
