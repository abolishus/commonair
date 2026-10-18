// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer, connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { HANDSHAKE_BYTES, KeyRewriter, placeholderFor, RtmpKeyProxy } from "../src/net/rtmp-proxy.ts";
import { parseTargetUrl } from "../src/net/ssrf.ts";

const logger = createLogger({ service: "test", level: "fatal" });
const KEY = "live_123456789_AbCdEfGhIjKlMnOp";

function rewriteAll(rw: KeyRewriter, data: Buffer, chunk: number): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += chunk) out.push(rw.push(Buffer.from(data.subarray(i, i + chunk))));
  out.push(rw.flush());
  return Buffer.concat(out);
}

describe("placeholderFor", () => {
  test("same byte length, alphanumeric, random", () => {
    const a = placeholderFor(KEY);
    expect(a).toHaveLength(KEY.length);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(placeholderFor(KEY)).not.toBe(a);
    expect(Buffer.byteLength(placeholderFor("ключ"))).toBe(Buffer.byteLength("ключ"));
  });
});

describe("KeyRewriter", () => {
  const P = Buffer.from("PLACEHOLDERxyz");
  const K = Buffer.from("secret-key-123");
  const command = (pad: number) =>
    Buffer.concat([Buffer.alloc(pad, 1), Buffer.from("\x02\x00\x0epublish"), P, Buffer.from("tail"), P]);

  test("replaces every occurrence inside the window, whatever the chunking", () => {
    const data = command(HANDSHAKE_BYTES + 10);
    const expected = Buffer.from(data);
    for (let i = expected.indexOf(P); i >= 0; i = expected.indexOf(P, i + 1)) K.copy(expected, i);
    for (const chunk of [1, 2, 3, 7, 13, 14, 15, 64, 4096, data.length]) {
      const out = rewriteAll(new KeyRewriter(P, K), data, chunk);
      expect(out.equals(expected), `chunk ${chunk}`).toBe(true);
    }
  });

  test("never touches the handshake or anything past the window", () => {
    const early = Buffer.concat([Buffer.alloc(5), P, Buffer.alloc(HANDSHAKE_BYTES)]);
    expect(rewriteAll(new KeyRewriter(P, K), early, 100).indexOf(P)).toBe(5);
    const late = Buffer.concat([Buffer.alloc(HANDSHAKE_BYTES + 100), P]);
    const out = rewriteAll(new KeyRewriter(P, K, HANDSHAKE_BYTES, HANDSHAKE_BYTES + 50), late, 33);
    expect(out.equals(late)).toBe(true);
  });

  test("preserves length and order of all bytes", () => {
    const data = Buffer.from(crypto.getRandomValues(new Uint8Array(100_000)));
    const out = rewriteAll(new KeyRewriter(P, K), data, 1000);
    expect(out.length).toBe(data.length);
  });

  test("holds back only a possible partial placeholder, so a command ending a write is not stalled", () => {
    const rw = new KeyRewriter(P, K);
    const head = Buffer.alloc(HANDSHAKE_BYTES + 5, 1);
    expect(rw.push(head).length).toBe(head.length);
    expect(rw.pending).toBe(0);
    const out = rw.push(Buffer.from("abcPLACE"));
    expect(out.toString()).toBe("abc");
    expect(rw.pending).toBe(5);
    expect(rw.push(Buffer.from("HOLDERxyz!")).toString()).toBe("secret-key-123!");
    expect(rw.pending).toBe(0);
    expect(rw.push(Buffer.from("PLA")).length).toBe(0);
    expect(rw.flush().toString()).toBe("PLA");
  });

  test("rejects mismatched lengths", () => {
    expect(() => new KeyRewriter(Buffer.from("ab"), Buffer.from("abc"))).toThrow("equal length");
    expect(() => new KeyRewriter(Buffer.alloc(0), Buffer.alloc(0))).toThrow("equal length");
  });
});

describe("RtmpKeyProxy", () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    // Newest first: the proxy drops its upstream sockets before the upstream server closes.
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function upstream(): Promise<{ port: number; received: () => Buffer; server: Server }> {
    const chunks: Buffer[] = [];
    const server = createServer((s) => {
      s.on("data", (c: Buffer) => chunks.push(c));
      s.write("hello-from-target");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    return { port: addr.port, received: () => Buffer.concat(chunks), server };
  }

  const dial = (port: number) =>
    new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: "127.0.0.1", port }, () => resolve(s));
      s.once("error", reject);
    });

  async function until(fn: () => boolean, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await Bun.sleep(20);
    }
  }

  test("forwards both ways and swaps the placeholder for the key", async () => {
    const up = await upstream();
    const placeholder = placeholderFor(KEY);
    const proxy = new RtmpKeyProxy({
      target: parseTargetUrl(`rtmp://127.0.0.1:${up.port}/live`),
      placeholder,
      secret: KEY,
      logger,
      resolve: { allowPrivate: true },
    });
    const port = await proxy.listen();
    cleanup.push(() => proxy.close());
    const client = await dial(port);
    let fromTarget = "";
    client.on("data", (c: Buffer) => (fromTarget += c.toString()));
    client.write(Buffer.alloc(HANDSHAKE_BYTES, 3));
    client.write(Buffer.from(`\x02\x00\x07publish...${placeholder}...`));
    await until(() => up.received().includes(Buffer.from(KEY)) && fromTarget === "hello-from-target");
    expect(up.received().includes(Buffer.from(placeholder))).toBe(false);
    expect(proxy.lastFailure).toBeNull();
    client.destroy();
  });

  test("refuses a private target unless allowed, and reports a generic failure", async () => {
    const up = await upstream();
    const proxy = new RtmpKeyProxy({
      target: parseTargetUrl(`rtmp://127.0.0.1:${up.port}/live`),
      placeholder: placeholderFor(KEY),
      secret: KEY,
      logger,
    });
    const port = await proxy.listen();
    cleanup.push(() => proxy.close());
    const client = await dial(port);
    let closed = false;
    client.on("close", () => (closed = true));
    client.on("error", () => {});
    await until(() => closed);
    expect(proxy.lastFailure).toBe("target_not_allowed");
    expect(up.received().length).toBe(0);
  });

  test("a refused connection upstream is a connection failure", async () => {
    const up = await upstream();
    const dead = up.port;
    await new Promise<void>((r) => up.server.close(() => r()));
    const proxy = new RtmpKeyProxy({
      target: parseTargetUrl(`rtmp://127.0.0.1:${dead}/live`),
      placeholder: placeholderFor(KEY),
      secret: KEY,
      logger,
      resolve: { allowPrivate: true },
    });
    const port = await proxy.listen();
    cleanup.push(() => proxy.close());
    const client = await dial(port);
    let closed = false;
    client.on("close", () => (closed = true));
    client.on("error", () => {});
    await until(() => closed);
    expect(proxy.lastFailure).toBe("connection_failed");
  });
});
