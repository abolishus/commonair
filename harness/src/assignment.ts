// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the API sent a playback session, read from the playback token's claims. Kept apart from
 * `viewer.ts` (which the browser player bundles) so it can use Node's Buffer.
 */
import type { DELIVERY_SOURCES } from "@commonair/contracts";

export type DeliverySource = (typeof DELIVERY_SOURCES)[number];

const SOURCES: readonly string[] = ["origin", "relay", "p2p", "cdn"] satisfies DeliverySource[];

/** The delivery source and, for relays, which relay. */
export interface PlaybackAssignment {
  source: DeliverySource;
  relayId: string | null;
}

/**
 * Decode `src` / `rid` from a playback token without verifying it: the harness only needs to know
 * where a session was sent, the services check signatures. Null for anything malformed.
 */
export function assignmentOf(token: string): PlaybackAssignment | null {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { src?: unknown; rid?: unknown };
    if (typeof claims.src !== "string" || !SOURCES.includes(claims.src)) return null;
    return { source: claims.src as DeliverySource, relayId: typeof claims.rid === "string" ? claims.rid : null };
  } catch {
    return null;
  }
}

/** The token carried by a playlist URL (`t=`), or null. */
export function tokenOfUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get("t");
  } catch {
    return null;
  }
}
