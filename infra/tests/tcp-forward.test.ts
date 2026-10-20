// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Socket, TCPSocketListener } from "bun";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { startForwarder } from "../railway/tcp-forward.ts";

const listeners: TCPSocketListener<unknown>[] = [];
afterEach(() => {
  for (const l of listeners.splice(0)) l.stop(true);
});

/** Echo server on a random loopback port; records how many connections it saw. */
function echoServer(): { port: number; connections: () => number } {
  let connections = 0;
  const pending = new Map<Socket<undefined>, Uint8Array[]>();
  const flush = (s: Socket<undefined>) => {
    const q = pending.get(s) ?? [];
    while (q.length > 0) {
      const head = q[0] as Uint8Array;
      const n = s.write(head);
      if (n < head.byteLength) {
        q[0] = head.subarray(Math.max(n, 0));
        return;
      }
      q.shift();
    }
  };
  const l = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        connections++;
        pending.set(s, []);
      },
      data(s, chunk) {
        pending.get(s)?.push(new Uint8Array(chunk));
        flush(s);
      },
      drain: flush,
      close(s) {
        pending.delete(s);
      },
    },
  });
  listeners.push(l as TCPSocketListener<unknown>);
  return { port: l.port, connections: () => connections };
}

function forwarder(targetPort: number, maxQueuedBytes?: number): number {
  const l = startForwarder({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort,
    maxQueuedBytes,
  });
  listeners.push(l as TCPSocketListener<unknown>);
  return l.port;
}

/** Connects, sends `payload` (in pieces), and resolves with everything received until `expected` bytes. */
async function roundTrip(port: number, payload: Uint8Array, expected = payload.byteLength): Promise<Uint8Array> {
  const received: Uint8Array[] = [];
  let total = 0;
  const { promise, resolve, reject } = Promise.withResolvers<Uint8Array>();
  let offset = 0;
  const pump = (s: Socket<undefined>) => {
    while (offset < payload.byteLength) {
      const n = s.write(payload.subarray(offset, Math.min(offset + 64 * 1024, payload.byteLength)));
      if (n <= 0) return;
      offset += n;
    }
  };
  const sock = await Bun.connect<undefined>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open: pump,
      drain: pump,
      data(_s, chunk) {
        received.push(new Uint8Array(chunk));
        total += chunk.byteLength;
        if (total >= expected) resolve(Buffer.concat(received));
      },
      close() {
        if (total < expected) reject(new Error(`closed after ${total} of ${expected} bytes`));
      },
      error: (_s, e) => reject(e),
    },
  });
  try {
    return await promise;
  } finally {
    sock.end();
  }
}

describe("tcp-forward", () => {
  test("forwards bytes both ways unchanged", async () => {
    const echo = echoServer();
    const port = forwarder(echo.port);
    const out = await roundTrip(port, new TextEncoder().encode("binding request"));
    expect(new TextDecoder().decode(out)).toBe("binding request");
    expect(echo.connections()).toBe(1);
  });

  test("carries a large stream intact under backpressure", async () => {
    const echo = echoServer();
    const port = forwarder(echo.port);
    const payload = new Uint8Array(4 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const out = await roundTrip(port, payload);
    expect(out.byteLength).toBe(payload.byteLength);
    expect(Buffer.compare(out, payload)).toBe(0);
  });

  test("keeps concurrent connections separate", async () => {
    const echo = echoServer();
    const port = forwarder(echo.port);
    const msgs = ["alpha", "bravo", "charlie", "delta"].map((m) => new TextEncoder().encode(m.repeat(1000)));
    const outs = await Promise.all(msgs.map((m) => roundTrip(port, m)));
    outs.forEach((o, i) => expect(Buffer.compare(o, msgs[i] as Uint8Array)).toBe(0));
    expect(echo.connections()).toBe(4);
  });

  test("closes the client when the target is unreachable", async () => {
    const dead = Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const deadPort = dead.port;
    dead.stop(true);
    const port = forwarder(deadPort);
    await expect(roundTrip(port, new TextEncoder().encode("x"))).rejects.toThrow(/closed after 0/);
  });

  test("rejects a bad port in the environment", async () => {
    const proc = Bun.spawn(["bun", new URL("../railway/tcp-forward.ts", import.meta.url).pathname], {
      env: { ...process.env, TARGET_HOST: "127.0.0.1", TARGET_PORT: "99999" },
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toMatch(/TARGET_PORT must be a TCP port/);
  });
});
