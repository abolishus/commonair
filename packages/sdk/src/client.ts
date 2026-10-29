// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The typed API client: oRPC's RPC protocol at `${baseUrl}/rpc`, typed by the CommonAir contract
 * (the same protocol the web app speaks). Errors are oRPC's `ORPCError` with the contract's codes;
 * `RATE_LIMITED` carries `data.retryAfterSeconds` (see `retryAfterSeconds`).
 */
import type { Contract } from "@commonair/contracts/api";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

export type CommonAirClient = ContractRouterClient<Contract>;
export type { Contract };

export type FetchLike = (request: Request) => Promise<Response>;

export interface ClientOptions {
  /** The instance's API origin, e.g. `https://example.org` (no trailing `/rpc`). */
  baseUrl: string;
  /** A fixed access token (user, bot or app token). */
  token?: string;
  /** Called before every request; plug `refreshingToken(...)` in here. Wins over `token`. */
  getToken?: () => string | Promise<string>;
  /** Replace the global `fetch` (tests, proxies, custom agents). */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds (default 15 000; 0 disables it). */
  timeoutMs?: number;
  /** Extra headers on every request (e.g. a `user-agent` naming your bot). */
  headers?: Record<string, string>;
}

export const trimBase = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

/** A typed client for every procedure of the contract. */
export function createClient(opts: ClientOptions): CommonAirClient {
  const doFetch: FetchLike = opts.fetch ?? ((r) => fetch(r));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const link = new RPCLink({
    url: `${trimBase(opts.baseUrl)}/rpc`,
    async headers() {
      const headers: Record<string, string> = { ...opts.headers };
      const token = opts.getToken ? await opts.getToken() : opts.token;
      if (token) headers.authorization = `Bearer ${token}`;
      return headers;
    },
    fetch(request) {
      if (timeoutMs <= 0) return doFetch(request);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
      return doFetch(new Request(request, { signal }));
    },
  });
  return createORPCClient<CommonAirClient>(link);
}
