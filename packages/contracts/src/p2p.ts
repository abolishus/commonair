// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Browser-safe P2P identifiers (ADR 0005 amendment 1, decision 5), shared by the player
 * (`@commonair/contracts/p2p`) and the tracker (also re-exported from `./internal`).
 *
 * The player sets the loader's `swarmId` to `PlaybackStart.p2p.swarmId` (the broadcast id) and
 * its `streamSwarmIdBuilder` to `p2pStreamSwarmId`, so the server can reproduce every stream swarm
 * id a granted session may join. The info hash a client announces is the loader's
 * `computeInfoHash(streamSwarmId)`: Base64 of the first 15 bytes of SHA-1, 20 ASCII characters.
 * `P2P_INFOHASH_VECTORS` pins that recipe for the tracker's reimplementation.
 */
import { RENDITIONS } from "./enums.ts";

export { P2P_INFOHASH_VECTORS } from "./p2p-vectors.ts";

/** The loader's stream types: `main` for variant playlists, `secondary` for audio tracks. */
export const P2P_STREAM_TYPES = ["main", "secondary"] as const;
export type P2PStreamType = (typeof P2P_STREAM_TYPES)[number];

/**
 * Names a stream swarm id may carry: the directory of the variant playlist
 * (`services/origin/src/paths.ts`; none means `source`), and `audio` for audio tracks.
 * `RENDITIONS` already holds `audio`, so this is the same list.
 */
export const P2P_STREAM_RENDITIONS: readonly string[] = [...new Set<string>([...RENDITIONS, "audio"])];

/** Prefix of every stream swarm id; a new recipe takes a new prefix. */
export const P2P_STREAM_SWARM_PREFIX = "ca1";

/** The loader's stream swarm id for one rendition of a session's swarm. */
export const p2pStreamSwarmId = (swarmId: string, type: P2PStreamType, rendition: string) =>
  `${P2P_STREAM_SWARM_PREFIX}:${swarmId}:${type}:${rendition}`;

/**
 * Every stream swarm id a session granted `swarmId` may join: both types × every name in
 * `P2P_STREAM_RENDITIONS`. A fixed, small set, so the tracker needs no `KEYS.renditions` read.
 */
export function p2pAllowedStreamSwarmIds(swarmId: string): string[] {
  return P2P_STREAM_TYPES.flatMap((type) => P2P_STREAM_RENDITIONS.map((r) => p2pStreamSwarmId(swarmId, type, r)));
}
