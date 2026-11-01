// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live captions: the subtitle playlist and WebVTT segments under
 * `/<route>/live/<slug>/captions/<language>/` (ADR 0011). W2-captions owns this file; the contract
 * step registers a stub that answers 404 for every request.
 */
import { parseCaptionsPath, ROUTES, type Route } from "./paths.ts";
import { routeNotFound, type OriginRouteContext, type OriginRouteRegistry } from "./routes.ts";

export function registerCaptionsRoutes(registry: OriginRouteRegistry, _ctx: OriginRouteContext): void {
  for (const route of Object.keys(ROUTES) as Route[])
    registry.register({
      name: `captions:${route}`,
      prefix: ROUTES[route],
      match: (rawPath) => parseCaptionsPath(rawPath) !== null,
      handle: () => Promise.resolve(routeNotFound()),
    });
}
