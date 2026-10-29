// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The machine OAuth endpoints (ADR 0027 §1-2): `POST /api/oauth2/token`, `/api/oauth2/revoke` and
 * `/api/oauth2/device`, raw form-encoded handlers per RFC 6749, 7009 and 8628 (not oRPC: clients
 * send `application/x-www-form-urlencoded` and expect RFC error bodies). Owned by E9-oauth; the
 * contract step mounted this stub in `http.ts`.
 */
import type { Deps } from "../deps.ts";
import type { RequestInfo } from "../lib/orpc.ts";

export async function oauthEndpoint(_deps: Deps, _req: Request, _info: RequestInfo): Promise<Response> {
  return Response.json(
    { error: "temporarily_unavailable" },
    { status: 501, headers: { "cache-control": "no-store", pragma: "no-cache" } },
  );
}
