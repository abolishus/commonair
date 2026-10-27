// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `GET /p2p-digest/live/<slug>[/<rendition>]/<file>?t=<token>`: the SHA-256 of a segment exactly
 * as `/hls/` serves it, 64 lowercase hex characters (ADR 0005 amendment 1, decision 7). Players
 * check every peer-delivered segment against it. Only the origin, the trust anchor, serves it.
 *
 * Contract-step stub: answers 501. P1-tracker owns this file and implements it.
 */
import type { Logger } from "@commonair/observability";
import type { ContentStore } from "./content.ts";
import type { OriginMetrics } from "./metrics.ts";

export const P2P_DIGEST_ROUTE = "/p2p-digest/";

export interface P2PDigestDeps {
  /** Verifies the viewer's playback token (`?t=`). */
  publicKey: CryptoKey;
  store: ContentStore;
  metrics?: OriginMetrics;
  logger?: Logger;
  now?: () => number;
}

export type P2PDigestFetch = (req: Request, rawPath: string) => Promise<Response>;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
};

export function createP2PDigestHandler(_deps: P2PDigestDeps): P2PDigestFetch {
  return (req) =>
    Promise.resolve(
      req.method === "OPTIONS"
        ? new Response(null, { status: 204, headers: CORS })
        : new Response("not implemented", { status: 501, headers: { ...CORS, "content-type": "text/plain" } }),
    );
}
