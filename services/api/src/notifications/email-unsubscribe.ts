// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * RFC 8058 one-click unsubscribe (ADR 0028 decision 4, Amendment 1): the `List-Unsubscribe` URL of
 * every notification email. A raw route, not an oRPC procedure: mail clients POST with no session,
 * no origin and a form body. No cookies are read and no CORS headers are sent.
 */
import { EMAIL_UNSUBSCRIBE_PATH, UNSUBSCRIBE_PAGE_PATH } from "@commonair/contracts/notify";
import type { Deps } from "../deps.ts";
import { rateLimitKey } from "../lib/ratelimit.ts";
import { applyUnsubscribe, isUnsubscribeList } from "./unsubscribe/apply.ts";

export const isEmailUnsubscribePath = (path: string): boolean => path === EMAIL_UNSUBSCRIBE_PATH;

const NO_STORE = { "cache-control": "no-store" };

function plain(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE, ...headers },
  });
}

/** The confirm page on the web origin, carrying only `list` and `token` from the request. */
export function confirmPageUrl(publicUrl: string, url: URL): string {
  const target = new URL(UNSUBSCRIBE_PAGE_PATH, `${publicUrl.replace(/\/+$/, "")}/`);
  for (const key of ["list", "token"]) {
    const value = url.searchParams.get(key);
    if (value !== null) target.searchParams.set(key, value);
  }
  return target.toString();
}

/**
 * GET (and HEAD): 303 to the confirm page with the same query. It never applies anything: mail
 * scanners prefetch links. POST (RFC 8058 one-click, body `List-Unsubscribe=One-Click`, form-encoded
 * or multipart; the body is not read, the token authorizes): apply and answer 200 "ok"; a bad link
 * 400; over the `write` limit for the address 429. Anything else 405.
 */
export async function emailUnsubscribe(deps: Deps, raw: Request, url: URL, rateLimitHash: string): Promise<Response> {
  if (raw.method === "GET" || raw.method === "HEAD")
    return new Response(null, {
      status: 303,
      headers: { location: confirmPageUrl(deps.site.publicUrl, url), ...NO_STORE },
    });
  if (raw.method !== "POST") return plain("method not allowed", 405, { allow: "GET, HEAD, POST" });

  const nowMs = deps.now().getTime();
  const rl = await deps.rateLimitStore.hit(
    rateLimitKey("write", `ip:${rateLimitHash}`),
    deps.rateLimits.write,
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (!rl.allowed) return plain("too many requests", 429, { "retry-after": String(rl.retryAfterSeconds) });

  const list = url.searchParams.get("list");
  const token = url.searchParams.get("token");
  if (!isUnsubscribeList(list) || token === null) return plain("invalid unsubscribe link", 400);
  const userId = await applyUnsubscribe(deps.db, deps.env.AUTH_SECRET, list, token);
  if (userId === null) return plain("invalid unsubscribe link", 400);
  deps.logger.info("email unsubscribe applied", { userId, list, via: "one-click" });
  return plain("ok", 200);
}
