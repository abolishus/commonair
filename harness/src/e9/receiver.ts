// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `developer-platform` scenario's receiver (docs/testing/e9-selectors.md): one Bun HTTP server
 * on this machine that is both the EventSub webhook callback (`POST /hook`, reached from the
 * stack's containers through `HARNESS_WEBHOOK_HOST`) and the OAuth loopback redirect target
 * (`GET /cb` on `127.0.0.1`). It records every request and answers the callback verification with
 * the challenge. Owned by the orchestrator: units send a contract request instead of editing it.
 */
import { WEBHOOK_HEADERS } from "@commonair/contracts/events";
import type { Server } from "bun";

export interface ReceivedRequest {
  method: string;
  /** Path without the query, e.g. `/hook` or `/cb`. */
  path: string;
  query: Record<string, string>;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The raw body, exactly as received (signatures cover these bytes). */
  body: string;
  receivedAt: number;
}

export interface Receiver {
  port: number;
  /** `http://127.0.0.1:<port>`: what this machine (and its browser) reaches. */
  origin: string;
  /** The webhook callback as the stack's containers reach it: `http://<HARNESS_WEBHOOK_HOST>:<port>/hook`. */
  url: string;
  /** The OAuth loopback redirect URI: `http://127.0.0.1:<port>/cb`. */
  callbackUrl: string;
  readonly requests: readonly ReceivedRequest[];
  /** Resolve with the first recorded request (past or future) matching `predicate`. */
  waitFor(predicate: (r: ReceivedRequest) => boolean, timeoutMs?: number): Promise<ReceivedRequest>;
  close(): Promise<void>;
}

const DEFAULT_WAIT_MS = 30_000;

export function startReceiver(opts: { webhookHost: string }): Receiver {
  const requests: ReceivedRequest[] = [];
  const waiters = new Set<{ predicate: (r: ReceivedRequest) => boolean; resolve: (r: ReceivedRequest) => void }>();

  const record = (r: ReceivedRequest) => {
    requests.push(r);
    for (const w of waiters)
      if (w.predicate(r)) {
        waiters.delete(w);
        w.resolve(r);
      }
  };

  const server: Server<undefined> = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      const r: ReceivedRequest = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body,
        receivedAt: Date.now(),
      };
      record(r);
      if (url.pathname === "/hook" && req.method === "POST") {
        if (r.headers[WEBHOOK_HEADERS.messageType] === "webhook_callback_verification") {
          const challenge = (() => {
            try {
              const c = (JSON.parse(body) as { challenge?: unknown }).challenge;
              return typeof c === "string" ? c : "";
            } catch {
              return "";
            }
          })();
          return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/cb" && req.method === "GET")
        return new Response("<!doctype html><title>harness</title><p>received</p>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      return new Response(null, { status: 404 });
    },
  });

  const port = server.port ?? 0;
  const origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    url: `http://${opts.webhookHost}:${port}/hook`,
    callbackUrl: `${origin}/cb`,
    requests,
    waitFor(predicate, timeoutMs = DEFAULT_WAIT_MS) {
      const past = requests.find(predicate);
      if (past) return Promise.resolve(past);
      return new Promise<ReceivedRequest>((resolve, reject) => {
        const w = {
          predicate,
          resolve: (r: ReceivedRequest) => {
            clearTimeout(timer);
            resolve(r);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`receiver: no matching request within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    async close() {
      await server.stop(true);
    },
  };
}
