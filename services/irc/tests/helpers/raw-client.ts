// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A minimal raw IRC client over TCP or TLS for integration tests (tmi.js only speaks WebSocket). */
import { parseMessage, type IrcMessage } from "../../src/irc/message.ts";

export interface RawClient {
  /** For TLS: whether the server certificate verified against the given CA. */
  authorized: boolean | null;
  send(...lines: string[]): void;
  /** Resolves with the first line (from now or already buffered) matching `pred`. */
  waitFor(pred: (m: IrcMessage, raw: string) => boolean, timeoutMs?: number): Promise<IrcMessage>;
  lines: string[];
  closed: Promise<void>;
  close(): void;
}

export async function rawClient(opts: { port: number; tls?: { ca: string } }): Promise<RawClient> {
  const lines: string[] = [];
  let buf = "";
  let consumed = 0;
  const waiters = new Set<() => void>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const decoder = new TextDecoder();
  let handshake: { resolve: (authorized: boolean) => void; reject: (e: Error) => void } | null = null;
  const handshaken = new Promise<boolean>((resolve, reject) => (handshake = { resolve, reject }));

  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: opts.port,
    ...(opts.tls ? { tls: { ca: opts.tls.ca, serverName: "localhost" } } : {}),
    socket: {
      // Bun drops writes made before the TLS handshake completes, so callers wait for it.
      handshake(_s, success, err) {
        if (success) handshake?.resolve(err === null);
        else handshake?.reject(err ?? new Error("TLS handshake failed"));
      },
      data(_s, chunk) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\r\n")) !== -1) {
          lines.push(buf.slice(0, nl));
          buf = buf.slice(nl + 2);
        }
        for (const w of waiters) w();
      },
      close() {
        resolveClosed();
        for (const w of waiters) w();
      },
      error() {
        resolveClosed();
      },
    },
  });

  const authorized = opts.tls ? await handshaken : null;

  return {
    authorized,
    lines,
    closed,
    send: (...ls) => {
      socket.write(ls.map((l) => `${l}\r\n`).join(""));
    },
    close: () => socket.end(),
    waitFor(pred, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          while (consumed < lines.length) {
            const raw = lines[consumed++] ?? "";
            const m = parseMessage(raw);
            if (m && pred(m, raw)) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(m);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out; got:\n${lines.join("\n")}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}

/** A raw IRC-over-WebSocket client (optionally with subprotocols and extra headers). */
export async function wsRawClient(opts: {
  port: number;
  protocols?: string[];
  headers?: Record<string, string>;
}): Promise<RawClient & { protocol: string }> {
  const lines: string[] = [];
  let consumed = 0;
  const waiters = new Set<() => void>();
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  const ws = new WebSocket(`ws://127.0.0.1:${opts.port}/`, {
    ...(opts.protocols ? { protocols: opts.protocols } : {}),
    headers: opts.headers ?? {},
  });
  ws.addEventListener("message", (ev: MessageEvent) => {
    const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    for (const l of text.split("\r\n")) if (l) lines.push(l);
    for (const w of waiters) w();
  });
  ws.addEventListener("close", () => {
    resolveClosed();
    for (const w of waiters) w();
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket failed to open")));
  });
  return {
    authorized: null,
    protocol: ws.protocol,
    lines,
    closed,
    send: (...ls) => ws.send(ls.join("\r\n")),
    close: () => ws.close(),
    waitFor(pred, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          while (consumed < lines.length) {
            const raw = lines[consumed++] ?? "";
            const m = parseMessage(raw);
            if (m && pred(m, raw)) {
              waiters.delete(check);
              clearTimeout(timer);
              resolve(m);
              return;
            }
          }
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out; got:\n${lines.join("\n")}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
  };
}
