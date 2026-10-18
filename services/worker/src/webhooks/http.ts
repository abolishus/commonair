// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outbound webhook POSTs. node:http(s) instead of fetch because it lets us pin
 * the connection to the pre-validated address via `lookup` while TLS still
 * verifies the certificate against the hostname. Redirects are never followed
 * (node:http does not follow them), the response body is capped and the whole
 * exchange has a hard deadline.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { CallbackRejected, resolveCallback, type Resolver } from "./ssrf.ts";

export interface PostOptions {
  allowInsecure: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  resolve?: Resolver;
  /** Extra trusted CA (PEM) for TLS; tests and private PKI only. System CAs are used otherwise. */
  ca?: string;
}

export type PostResult =
  | { ok: true; status: number; body: string; latencyMs: number; truncated: boolean }
  | { ok: false; error: string; latencyMs: number; rejected: boolean };

export async function postWebhook(
  callback: string,
  headers: Record<string, string>,
  body: string,
  opts: PostOptions,
): Promise<PostResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  let target;
  try {
    target = await resolveCallback(callback, opts);
  } catch (err) {
    const msg = err instanceof CallbackRejected ? err.message : "callback resolution failed";
    return { ok: false, error: msg, latencyMs: elapsed(), rejected: true };
  }
  const { url, hostname, address } = target;
  const pinned: LookupFunction = (_host, options, cb) => {
    if (options && options.all) cb(null, [{ address: address.address, family: address.family }]);
    else cb(null, address.address, address.family);
  };
  const mod = url.protocol === "https:" ? https : http;

  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const finish = (r: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(r);
    };
    const req = mod.request(
      {
        method: "POST",
        protocol: url.protocol,
        host: hostname,
        servername: hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        lookup: pinned,
        agent: false,
        ...(opts.ca ? { ca: opts.ca } : {}),
        headers: {
          ...headers,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "user-agent": "CommonAir-EventSub/1",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () =>
          finish({
            ok: true,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            latencyMs: elapsed(),
            truncated,
          });
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = opts.maxResponseBytes - size;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, Math.max(0, room)));
            size += Math.max(0, room);
            truncated = true;
            // Enough read: drop the rest instead of buffering an unbounded body.
            res.destroy();
            done();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        res.on("end", done);
        res.on("error", () => done());
      },
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error("timeout"));
      finish({ ok: false, error: `timeout after ${opts.timeoutMs} ms`, latencyMs: elapsed(), rejected: false });
    }, opts.timeoutMs);
    req.on("error", (err) => finish({ ok: false, error: sanitizeError(err), latencyMs: elapsed(), rejected: false }));
    req.end(body);
  });
}

/** Network error text for the delivery log: the code and message, never a stack. */
function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return (code ? `${code}: ${err.message}` : err.message).slice(0, 300);
  }
  return "request failed";
}
