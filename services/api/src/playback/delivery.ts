// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Delivery-source assignment for new playback sessions (pure).
 *
 * Active relays with spare capacity get a share of new sessions weighted by declared
 * capacity; the origin keeps a weight of (total relay capacity / N), i.e. at least
 * 1/(N+1) of new sessions. The pick is a deterministic function of the session id.
 * Sessions the origin keeps go to the CDN instead when origin-pull CDN is enabled and
 * the channel's verified viewers exceed the burst threshold.
 */
import { z } from "zod";
import { stableHash } from "../discovery/ranking.ts";

/** Shape of each KEYS.relays hash value (written by relay heartbeats). */
export const RelayEntry = z.object({
  url: z.string(),
  capacityMbps: z.number().nonnegative(),
  status: z.string(),
  /** Current egress in Mbps. */
  load: z.number().nonnegative(),
});
export type RelayEntry = z.infer<typeof RelayEntry>;

/** Relays above this fraction of declared capacity take no new sessions. */
export const RELAY_HEADROOM = 0.9;

export type Assignment = { source: "origin" } | { source: "cdn" } | { source: "relay"; relayId: string; url: string };

export interface AssignInput {
  sessionId: string;
  relays: ReadonlyArray<{ id: string } & RelayEntry>;
  cdn: { enabled: boolean; threshold: number };
  channelVerifiedViewers: number;
}

export function eligibleRelays(relays: AssignInput["relays"]) {
  return relays
    .filter((r) => r.status === "active" && r.capacityMbps > 0 && r.load < r.capacityMbps * RELAY_HEADROOM)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Uniform in [0, 1) from the session id. */
export const unitHash = (s: string) => stableHash(`delivery:${s}`) / 0x1_0000_0000;

export function assignSource(input: AssignInput): Assignment {
  const relays = eligibleRelays(input.relays);
  if (relays.length > 0) {
    const total = relays.reduce((s, r) => s + r.capacityMbps, 0);
    const originWeight = total / relays.length;
    let x = unitHash(input.sessionId) * (total + originWeight);
    if (x >= originWeight) {
      x -= originWeight;
      for (const r of relays) {
        if (x < r.capacityMbps) return { source: "relay", relayId: r.id, url: r.url };
        x -= r.capacityMbps;
      }
      const last = relays[relays.length - 1];
      if (last) return { source: "relay", relayId: last.id, url: last.url };
    }
  }
  if (input.cdn.enabled && input.channelVerifiedViewers > input.cdn.threshold) return { source: "cdn" };
  return { source: "origin" };
}
