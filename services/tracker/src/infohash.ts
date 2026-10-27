// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-derived info hashes (ADR 0005 amendment 1, decision 5). A granted session may announce
 * only the hashes of `p2pAllowedStreamSwarmIds(swarmId)`, where `swarmId` is the value of its
 * `KEYS.p2pGrant`. The hash recipe is p2p-media-loader-core 4.0.0's `computeInfoHash`
 * (`src/stream-identity.ts:124-126`): Base64 of the first 15 bytes of SHA-1 over the UTF-8 stream
 * swarm id, 20 ASCII characters. It is reimplemented here so the tracker never imports the
 * browser library; `P2P_INFOHASH_VECTORS` pins it.
 */
import { createHash } from "node:crypto";
import { p2pAllowedStreamSwarmIds } from "@commonair/contracts/internal";

/** The loader's info hash for one stream swarm id. */
export function computeInfoHash(streamSwarmId: string): string {
  return createHash("sha1").update(streamSwarmId, "utf8").digest().subarray(0, 15).toString("base64");
}

/** The number of hashes a grant allows (both stream types × every rendition name). */
export const ALLOWED_PER_GRANT = p2pAllowedStreamSwarmIds("").length;

/**
 * Allowed info hashes per swarm id, in a small LRU: every socket of one broadcast shares a grant,
 * so one entry serves them all, and a broadcast that ended falls out on its own.
 */
export class InfoHashAllowlist {
  private readonly cache = new Map<string, ReadonlySet<string>>();

  constructor(private readonly capacity = 256) {}

  get size(): number {
    return this.cache.size;
  }

  get(swarmId: string): ReadonlySet<string> {
    const hit = this.cache.get(swarmId);
    if (hit) {
      // Re-insert to mark it most recently used.
      this.cache.delete(swarmId);
      this.cache.set(swarmId, hit);
      return hit;
    }
    const set: ReadonlySet<string> = new Set(p2pAllowedStreamSwarmIds(swarmId).map(computeInfoHash));
    this.cache.set(swarmId, set);
    if (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    return set;
  }

  allows(swarmId: string, infoHash: string): boolean {
    return this.get(swarmId).has(infoHash);
  }
}
