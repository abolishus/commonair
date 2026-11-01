// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The raw ActivityPub and discovery routes (ADR 0030): WebFinger, NodeInfo, the actor document,
 * its outbox and followers collections, and the per-channel and shared inboxes. `http.ts` matches
 * the paths (`../raw-routes.ts`), checks the method and answers 404 itself while
 * `FEDERATION_ENABLED` is false, so this module is reached only with the flag on.
 *
 * Contract-step stub: N4-api fills it (content negotiation, the inbox's cheap checks, rate
 * limits). Until then every route answers 501.
 */
import type { BaseContext } from "../lib/orpc.ts";
import type { FederationRoute } from "../raw-routes.ts";

export async function federationHttp(_ctx: BaseContext, _req: Request, _route: FederationRoute): Promise<Response> {
  return Response.json(
    { code: "NOT_IMPLEMENTED", message: "Not implemented yet" },
    { status: 501, headers: { "cache-control": "no-store" } },
  );
}
