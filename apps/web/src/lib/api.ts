// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed API clients. In the browser the API is same-origin (`/rpc`, proxied by the web server),
 * so the session cookie rides along. On the server, `serverApi` talks to API_INTERNAL_URL and
 * forwards the visitor's cookie explicitly.
 */
import type { Contract } from "@commonair/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";

export type Api = ContractRouterClient<Contract>;

let browserClient: Api | null = null;

export function api(): Api {
  browserClient ??= createORPCClient(new RPCLink({ url: () => `${window.location.origin}/rpc` }));
  return browserClient;
}

let keepaliveClient: Api | null = null;

/** For calls made while the page unloads (`playback.end` on pagehide): the request outlives the page. */
export function apiKeepalive(): Api {
  keepaliveClient ??= createORPCClient(
    new RPCLink({
      url: () => `${window.location.origin}/rpc`,
      fetch: (request, init) => fetch(request, { ...init, keepalive: true }),
    }),
  );
  return keepaliveClient;
}

export function serverApi(baseUrl: string, headers: Record<string, string> = {}): Api {
  return createORPCClient(new RPCLink({ url: `${baseUrl.replace(/\/+$/, "")}/rpc`, headers }));
}

/** oRPC error code of a failed call, if any (`UNAUTHORIZED`, `NOT_FOUND`, …). */
export function errorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") return err.code;
  return null;
}
