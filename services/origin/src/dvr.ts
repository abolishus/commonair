// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live DVR, `GET|HEAD /dvr/<vodId>/<file>?t=<token>` (ADR 0016). W2-dvr owns this file; the
 * contract step registers a stub that answers 404 for every request.
 */
import { DVR_ROUTE } from "@commonair/contracts/storage";
import { routeNotFound, type OriginRouteContext, type OriginRouteRegistry } from "./routes.ts";

export function registerDvrRoutes(registry: OriginRouteRegistry, _ctx: OriginRouteContext): void {
  registry.register({ name: "dvr", prefix: DVR_ROUTE, handle: () => Promise.resolve(routeNotFound()) });
}
