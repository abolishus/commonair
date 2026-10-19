// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-side P2P evidence (ADR 0005): every accepted announce is recorded in Valkey under
 * `KEYS.p2pPeer(sid)` and `KEYS.p2pSwarm(swarm)` for integrity to read, and every completed
 * offer/answer exchange under `KEYS.p2pLinks` of both sessions. The announcing network is stored
 * only as an HMAC of its /24 or /48 prefix, never the address.
 *
 * A session's `swarm` field is the swarm of its latest announce: one that announces to a second
 * info hash moves there (integrity judges one swarm per session). Its membership in the earlier
 * swarm's ZSET stays until it stops, disconnects, or ages out of the TTL.
 *
 * `p2pChannelNet(channelId, net)` counts the channel's announcers per network across all of its
 * swarms (client-chosen info hashes make per-swarm counts meaningless) and is never pruned on
 * leave.
 */
import { KEYS, P2P_EVIDENCE } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";
import { networkPrefix } from "./ip.ts";

const enc = new TextEncoder();
const toHex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");

export class Evidence {
  private readonly key: Promise<CryptoKey>;
  private readonly ttlSeconds: number;

  constructor(
    private readonly valkey: ValkeyClient,
    internalSecret: string,
    ttlSeconds: number = P2P_EVIDENCE.peerTtlSeconds,
  ) {
    this.ttlSeconds = ttlSeconds;
    this.key = netKey(internalSecret);
  }

  /** Hex HMAC-SHA256(netKey, network prefix) of a canonical address (`KEYS.p2pPeer` `net`). */
  async networkHash(ip: string): Promise<string> {
    const prefix = networkPrefix(ip) ?? ip;
    return toHex(await crypto.subtle.sign("HMAC", await this.key, enc.encode(prefix)));
  }

  /** Record one accepted announce. Throws on a Valkey error; the caller logs and carries on. */
  async record(sid: string, channelId: string, swarm: string, net: string, nowMs: number): Promise<void> {
    const peer = KEYS.p2pPeer(sid);
    const swarmKey = KEYS.p2pSwarm(swarm);
    const chnet = KEYS.p2pChannelNet(channelId, net);
    const cutoff = `(${nowMs - this.ttlSeconds * 1000}`;
    const results = await this.valkey
      .pipeline()
      .hset(peer, { swarm, net, last: String(nowMs) })
      .hsetnx(peer, "first", String(nowMs))
      .hincrby(peer, "announces", 1)
      .expire(peer, this.ttlSeconds)
      .zadd(swarmKey, nowMs, sid)
      .zremrangebyscore(swarmKey, "-inf", cutoff)
      .expire(swarmKey, this.ttlSeconds)
      .zadd(chnet, nowMs, sid)
      .zremrangebyscore(chnet, "-inf", cutoff)
      .expire(chnet, this.ttlSeconds)
      .exec();
    throwOnError(results);
  }

  /**
   * The tracker relayed an offer between sessions `a` and `b` and the matching answer came back:
   * each session's `p2pLinks` gets the other's network. Same TTL and trimming as `p2pPeer`.
   */
  async link(a: { sid: string; net: string }, b: { sid: string; net: string }, nowMs: number): Promise<void> {
    const cutoff = `(${nowMs - this.ttlSeconds * 1000}`;
    const p = this.valkey.pipeline();
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const key = KEYS.p2pLinks(self.sid);
      p.zadd(key, nowMs, other.net).zremrangebyscore(key, "-inf", cutoff).expire(key, this.ttlSeconds);
    }
    throwOnError(await p.exec());
  }

  /**
   * The session left these swarms (stopped or disconnected): live membership only. `p2pPeer`,
   * `p2pLinks` and `p2pChannelNet` stay until the TTL, so leaving never dodges the per-network cap.
   */
  async forget(sid: string, swarms: readonly string[]): Promise<void> {
    if (swarms.length === 0) return;
    const p = this.valkey.pipeline();
    for (const swarm of swarms) p.zrem(KEYS.p2pSwarm(swarm), sid);
    throwOnError(await p.exec());
  }
}

/**
 * Purpose-bound subkey HMAC-SHA256(INTERNAL_API_SECRET, "p2p-net-v1") (contracts `KEYS.p2pPeer`),
 * so network hashes never collide with other HMACs keyed by the same secret.
 */
async function netKey(secret: string): Promise<CryptoKey> {
  const hmac = { name: "HMAC", hash: "SHA-256" } as const;
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), hmac, false, ["sign"]);
  const sub = await crypto.subtle.sign("HMAC", root, enc.encode("p2p-net-v1"));
  return crypto.subtle.importKey("raw", sub, hmac, false, ["sign"]);
}

function throwOnError(results: [Error | null, unknown][] | null): void {
  if (!results) throw new Error("pipeline aborted");
  for (const [err] of results) if (err) throw err;
}
