// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed API client generated from the oRPC contract, speaking the RPC protocol at `/rpc` exactly
 * like the web app. Each simulated user gets its own cookie jar, so sessions never leak between
 * users, and an optional simulated client address for the forwarding proxy.
 */
import type { Contract } from "@commonair/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { CookieJar, type FetchLike, jarFetch } from "./cookies.ts";

export type ApiClient = ContractRouterClient<Contract>;

/** Header the harness forwarding proxy turns into `x-forwarded-for` (and strips). */
export const SIMULATED_IP_HEADER = "x-harness-client-ip";

export interface ApiClientOptions {
  /** API base URL (or the forwarding proxy's URL), no trailing slash. */
  baseUrl: string;
  /** Sent as Origin on every request; better-auth refuses cookie writes from unknown origins. */
  origin?: string;
  jar?: CookieJar;
  /** Bearer token (bots and OAuth apps) instead of a session cookie. */
  bearer?: string;
  /** Simulated client address, honoured only when `baseUrl` is the forwarding proxy. */
  clientIp?: string;
  userAgent?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface Api {
  client: ApiClient;
  jar: CookieJar;
  /** Cookie- and header-aware fetch for non-RPC endpoints (auth routes). */
  fetch: FetchLike;
  baseUrl: string;
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function createApi(opts: ApiClientOptions): Api {
  const jar = opts.jar ?? new CookieJar();
  const headers: Record<string, string> = { "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT };
  if (opts.origin) headers.origin = opts.origin;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  if (opts.clientIp) headers[SIMULATED_IP_HEADER] = opts.clientIp;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timed: FetchLike = (request) => fetch(request, { signal: AbortSignal.timeout(timeoutMs) });
  const f = jarFetch(jar, headers, timed);
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const link = new RPCLink({ url: `${baseUrl}/rpc`, fetch: (request) => f(request) });
  return { client: createORPCClient<ApiClient>(link), jar, fetch: f, baseUrl };
}
