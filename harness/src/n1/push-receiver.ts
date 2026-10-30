// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `notifications` scenario's push endpoint (docs/testing/n1-selectors.md): one Bun HTTP server
 * on this machine standing in for a browser vendor's push service. The worker reaches it from the
 * stack's containers through `HARNESS_WEBHOOK_HOST` (allowed by `WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`,
 * harness/compose.n1.yaml). It records each `POST /push/<id>` as raw bytes with lower-case headers
 * and answers the status the step set for that id (201 by default; e.g. 410 to expire it). Owned by
 * the orchestrator: units send a contract request instead of editing it.
 */
import type { Server } from "bun";

export interface PushRequest {
  /** The `<id>` of `/push/<id>`. */
  id: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** The encrypted body exactly as received (RFC 8188 `aes128gcm`). */
  body: Uint8Array;
  /** What the receiver answered. */
  status: number;
  receivedAt: number;
}

export interface PushReceiver {
  port: number;
  /** The endpoints' origin as the worker reaches it: `http://<HARNESS_WEBHOOK_HOST>:<port>` (the VAPID `aud`). */
  origin: string;
  /** A push endpoint for one subscription: `${origin}/push/<id>`. */
  endpoint(id: string): string;
  /** What `POST /push/<id>` answers from now on (201 until set). */
  setStatus(id: string, status: number): void;
  readonly requests: readonly PushRequest[];
  /** Resolve with the first recorded request (past or future) matching `predicate`. */
  waitFor(predicate: (r: PushRequest) => boolean, timeoutMs?: number): Promise<PushRequest>;
  close(): Promise<void>;
}

const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_STATUS = 201;
const PUSH_PATH = /^\/push\/([A-Za-z0-9_-]{1,128})$/;

export function startPushReceiver(opts: { webhookHost: string }): PushReceiver {
  const requests: PushRequest[] = [];
  const statuses = new Map<string, number>();
  const waiters = new Set<{ predicate: (r: PushRequest) => boolean; resolve: (r: PushRequest) => void }>();

  const record = (r: PushRequest) => {
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
      const id = PUSH_PATH.exec(new URL(req.url).pathname)?.[1];
      if (req.method !== "POST" || id === undefined) return new Response(null, { status: 404 });
      // Record the body first, whatever the answer: a 410 still delivered the message to us.
      const body = new Uint8Array(await req.arrayBuffer());
      const status = statuses.get(id) ?? DEFAULT_STATUS;
      record({
        id,
        headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])),
        body,
        status,
        receivedAt: Date.now(),
      });
      return new Response(null, { status });
    },
  });

  const port = server.port ?? 0;
  const origin = `http://${opts.webhookHost}:${port}`;
  return {
    port,
    origin,
    endpoint: (id) => {
      if (!PUSH_PATH.test(`/push/${id}`)) throw new Error(`push receiver: bad id "${id}"`);
      return `${origin}/push/${id}`;
    },
    setStatus: (id, status) => {
      statuses.set(id, status);
    },
    requests,
    waitFor(predicate, timeoutMs = DEFAULT_WAIT_MS) {
      const past = requests.find(predicate);
      if (past) return Promise.resolve(past);
      return new Promise<PushRequest>((resolve, reject) => {
        const w = {
          predicate,
          resolve: (r: PushRequest) => {
            clearTimeout(timer);
            resolve(r);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`push receiver: no matching request within ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.add(w);
      });
    },
    async close() {
      await server.stop(true);
    },
  };
}
