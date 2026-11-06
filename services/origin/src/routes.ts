// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The origin route registry (batch 6 decision (n)). Feature routes (`dvr.ts`, `captions.ts`)
 * register `{prefix, match?, handle}` entries at startup; `origin.ts` asks the registry before its
 * built-in routes, so a unit adds a route without editing `origin.ts`, `handler.ts` or `paths.ts`.
 * The first registered entry whose prefix (and `match`, when given) accepts the raw path wins.
 */
import type { Executor } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { SegmentLog } from "./accounting.ts";
import type { ChannelDirectory } from "./channels.ts";
import type { ContentStore } from "./content.ts";
import type { DvrPullStore } from "./dvr-issuance.ts";
import type { MediaDeps } from "./media.ts";
import type { OriginMetrics } from "./metrics.ts";
import type { TokenRefresher } from "./refresh.ts";
import type { VodStateCache } from "./vod.ts";

/** Handles one request; `rawPath` is the un-normalized path (`rawPathOf`). */
export type RouteHandler = (req: Request, rawPath: string, peerIp?: string) => Promise<Response>;

export interface OriginRoute {
  /** For logs and metrics. */
  name: string;
  /** Raw path prefix, e.g. `/dvr/`. */
  prefix: string;
  /** Narrows a shared prefix (the captions route lives under `/hls/live/<slug>/`). */
  match?: (rawPath: string) => boolean;
  handle: RouteHandler;
}

/** What a registered route may use. Shared with the built-in routes, so caches and accounting are one per origin. */
export interface OriginRouteContext {
  db: Executor;
  valkey: ValkeyClient;
  /** Verifies playback tokens. */
  publicKey: CryptoKey;
  /** MediaMTX content cache (live playlists and segments). */
  store: ContentStore;
  channels: ChannelDirectory;
  /**
   * The segment log hook: every media playlist or segment a registered route serves to a viewer
   * goes through `segments.record(...)` (with `mode: "dvr"` for `/dvr/`), so integrity and egress
   * accounting see it. HEAD requests and captions (not media) are not recorded.
   */
  segments: SegmentLog;
  refresher: TokenRefresher;
  /** The 5 s VOD state cache `/media/` and `/vod/` share (DVR state included). */
  vodStates: VodStateCache;
  /** Object storage for VOD and recording objects; absent when the origin serves no media. */
  media?: Omit<MediaDeps, "logger" | "vodStates">;
  /** `DVR_MAX_WINDOW_SECONDS`. */
  dvrMaxWindowSeconds: number;
  /** Where `/relay-pull/dvr/` counts the objects it serves relays, for relay issuance; absent = not counted. */
  dvrPulls?: DvrPullStore;
  metrics: OriginMetrics;
  logger?: Logger;
  /** Milliseconds. */
  now: () => number;
}

export class OriginRouteRegistry {
  private readonly routes: OriginRoute[] = [];

  register(route: OriginRoute): void {
    if (!route.prefix.startsWith("/")) throw new Error(`route prefix must start with "/": ${route.prefix}`);
    if (this.routes.some((r) => r.name === route.name)) throw new Error(`route already registered: ${route.name}`);
    this.routes.push(route);
  }

  find(rawPath: string): OriginRoute | undefined {
    return this.routes.find((r) => rawPath.startsWith(r.prefix) && (r.match?.(rawPath) ?? true));
  }

  get names(): string[] {
    return this.routes.map((r) => r.name);
  }
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range",
  "access-control-expose-headers": "content-length, content-type",
  "access-control-max-age": "86400",
};

/** The 404 every stub answers (and a real route answers for anything it will not serve). */
export function routeNotFound(): Response {
  return Response.json({ error: "not_found" }, { status: 404, headers: { ...CORS, "cache-control": "no-store" } });
}
