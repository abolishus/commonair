// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * In-memory swarms and the announce/scrape semantics, independent of sockets so it can be
 * unit tested. A swarm is keyed by `p2pSwarmId(channelId, hex(info_hash))`: the playback token
 * binds a socket to one channel, so sockets of different channels never meet even when they
 * announce the same info hash.
 */
import { p2pSwarmId } from "@commonair/contracts/internal";
import { PendingExchanges } from "./exchanges.ts";
import { binaryToHex, LIMITS, type AnnounceFrame, type Frame, type ScrapeFrame } from "./protocol.ts";

/** What the registry needs from a socket. */
export interface Conn {
  /** Playback session id (one socket per session). */
  readonly sid: string;
  readonly channelId: string;
  /** Offers this socket sent that were relayed and await an answer. */
  readonly pending: PendingExchanges;
  /** Swarm id → this socket's peer id in it. Maintained by the registry. */
  readonly swarms: Map<string, string>;
  send(msg: object): void;
}

interface PeerEntry {
  conn: Conn;
  peerId: string;
  /** Seeder: announced `left: 0` or `event: completed`. */
  complete: boolean;
  /** Counted once in `downloaded`. */
  completed: boolean;
  /** Position in `Swarm.list`, for O(1) removal and random sampling. */
  index: number;
}

interface Swarm {
  peers: Map<string, PeerEntry>;
  list: PeerEntry[];
  /** Running count of entries with `complete` set. */
  complete: number;
  downloaded: number;
}

export interface SwarmCounts {
  complete: number;
  incomplete: number;
  downloaded: number;
}

export type Outcome =
  | {
      kind: "announce";
      swarm: string;
      offersRelayed: number;
      answerRelayed: boolean;
      /** Set when this frame answered an offer the tracker relayed to it: the offering socket. */
      exchange: Conn | null;
    }
  | { kind: "stopped"; swarm: string }
  | { kind: "scrape" }
  | { kind: "refused"; reason: string };

export interface RegistryOptions {
  /** TRACKER_MAX_NUMWANT: most offers relayed per announce. */
  maxNumwant: number;
  random?: () => number;
  now?: () => number;
  /** Called with +1 / -1 when a swarm is created or emptied. */
  onSwarmCount?: (delta: number) => void;
}

const ZERO: SwarmCounts = { complete: 0, incomplete: 0, downloaded: 0 };

export class SwarmRegistry {
  private readonly swarms = new Map<string, Swarm>();
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: RegistryOptions) {
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.swarms.size;
  }

  counts(swarm: string): SwarmCounts {
    const s = this.swarms.get(swarm);
    if (!s) return { ...ZERO };
    return { complete: s.complete, incomplete: s.list.length - s.complete, downloaded: s.downloaded };
  }

  handle(conn: Conn, frame: Frame): Outcome {
    return frame.action === "scrape" ? this.scrape(conn, frame) : this.announce(conn, frame);
  }

  /** Remove `conn` from every swarm (socket closed). Returns the swarm ids it left. */
  leaveAll(conn: Conn): string[] {
    const left = [...conn.swarms.keys()];
    for (const swarm of left) this.leave(conn, swarm);
    return left;
  }

  leave(conn: Conn, swarm: string): void {
    const peerId = conn.swarms.get(swarm);
    if (peerId === undefined) return;
    conn.swarms.delete(swarm);
    const s = this.swarms.get(swarm);
    const entry = s?.peers.get(peerId);
    if (!s || !entry || entry.conn !== conn) return;
    s.peers.delete(peerId);
    if (entry.complete) s.complete--;
    const last = s.list.pop();
    if (last && last !== entry) {
      s.list[entry.index] = last;
      last.index = entry.index;
    }
    if (s.list.length === 0) {
      this.swarms.delete(swarm);
      this.opts.onSwarmCount?.(-1);
    }
  }

  private announce(conn: Conn, f: AnnounceFrame): Outcome {
    const swarm = p2pSwarmId(conn.channelId, binaryToHex(f.infoHash));
    let s = this.swarms.get(swarm);
    let entry = s?.peers.get(f.peerId);
    if (entry && entry.conn !== conn) return this.refuse(conn, "peer_id in use", f.infoHash);

    if (f.event === "stopped") {
      this.leave(conn, swarm);
      conn.send(this.response(swarm, f.infoHash));
      return { kind: "stopped", swarm };
    }

    if (!entry) {
      const previous = conn.swarms.get(swarm);
      // Same socket, new peer id for this swarm: the client restarted its torrent; replace it.
      if (previous !== undefined) this.leave(conn, swarm);
      else if (conn.swarms.size >= LIMITS.maxSwarmsPerSocket) return this.refuse(conn, "too many swarms", f.infoHash);
      s = this.swarms.get(swarm);
      if (!s) {
        s = { peers: new Map(), list: [], complete: 0, downloaded: 0 };
        this.swarms.set(swarm, s);
        this.opts.onSwarmCount?.(1);
      }
      entry = { conn, peerId: f.peerId, complete: false, completed: false, index: s.list.length };
      s.peers.set(f.peerId, entry);
      s.list.push(entry);
      conn.swarms.set(swarm, f.peerId);
    }
    // Invariant: the branch above created the swarm if it was missing.
    const sw = s as Swarm;

    const wasComplete = entry.complete;
    if (f.left === 0 || f.event === "completed") entry.complete = true;
    else if (f.left !== undefined) entry.complete = false;
    if (entry.complete !== wasComplete) sw.complete += entry.complete ? 1 : -1;
    if (f.event === "completed" && !entry.completed) {
      entry.completed = true;
      sw.downloaded++;
    }

    // Answers are a reply to one peer, not a re-announce: no interval response for them.
    if (!f.answer) conn.send(this.response(swarm, f.infoHash));

    let offersRelayed = 0;
    if (f.offers.length > 0) {
      const want = Math.min(f.numwant ?? f.offers.length, this.opts.maxNumwant, f.offers.length);
      const targets = this.sample(sw, entry, want);
      targets.forEach((target, i) => {
        const o = f.offers[i];
        if (!o) return;
        target.conn.send({
          action: "announce",
          offer: o.offer,
          offer_id: o.offerId,
          peer_id: f.peerId,
          info_hash: f.infoHash,
        });
        conn.pending.add(o.offerId, target.conn.sid, swarm, this.now());
        offersRelayed++;
      });
    }

    let answerRelayed = false;
    let exchange: Conn | null = null;
    if (f.answer) {
      const target = sw.peers.get(f.answer.toPeerId);
      if (target && target.conn !== conn) {
        // Only an answer to an offer the tracker relayed to this session completes an exchange.
        if (target.conn.pending.complete(f.answer.offerId, conn.sid, swarm, this.now())) exchange = target.conn;
        target.conn.send({
          action: "announce",
          answer: f.answer.sdp,
          offer_id: f.answer.offerId,
          peer_id: f.peerId,
          info_hash: f.infoHash,
        });
        answerRelayed = true;
      }
    }
    return { kind: "announce", swarm, offersRelayed, answerRelayed, exchange };
  }

  private scrape(conn: Conn, f: ScrapeFrame): Outcome {
    const files: Record<string, SwarmCounts> = {};
    if (f.infoHashes.length === 0) {
      // Without hashes, only the swarms this socket is in: never enumerate other channels.
      for (const [swarm, peerId] of conn.swarms) {
        const entry = this.swarms.get(swarm)?.peers.get(peerId);
        const hash = entry ? this.infoHashOf(swarm) : null;
        if (hash !== null) files[hash] = this.counts(swarm);
      }
    } else {
      for (const h of f.infoHashes) files[h] = this.counts(p2pSwarmId(conn.channelId, binaryToHex(h)));
    }
    conn.send({ action: "scrape", files });
    return { kind: "scrape" };
  }

  /** Binary info hash from a swarm id (`<channelId>:<hex>`). */
  private infoHashOf(swarm: string): string | null {
    const hex = swarm.slice(swarm.lastIndexOf(":") + 1);
    return /^[0-9a-f]{40}$/.test(hex) ? Buffer.from(hex, "hex").toString("latin1") : null;
  }

  private response(swarm: string, infoHash: string) {
    const { complete, incomplete } = this.counts(swarm);
    return { action: "announce", interval: LIMITS.announceInterval, info_hash: infoHash, complete, incomplete };
  }

  private refuse(conn: Conn, reason: string, infoHash: string): Outcome {
    conn.send({ action: "announce", "failure reason": reason, info_hash: infoHash });
    return { kind: "refused", reason };
  }

  /** Up to `n` distinct random peers other than `self`. */
  private sample(s: Swarm, self: PeerEntry, n: number): PeerEntry[] {
    const others = s.list.length - 1;
    if (n <= 0 || others <= 0) return [];
    if (n * 2 >= others) {
      // Small swarm relative to the ask: shuffle a copy (partial Fisher-Yates).
      const pool = s.list.filter((p) => p !== self);
      const k = Math.min(n, pool.length);
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(this.random() * (pool.length - i));
        const tmp = pool[i] as PeerEntry;
        pool[i] = pool[j] as PeerEntry;
        pool[j] = tmp;
      }
      return pool.slice(0, k);
    }
    // Large swarm: rejection-sample indices; at most half the candidates are ever taken, so this
    // ends quickly in expectation.
    const picked = new Set<PeerEntry>();
    for (let attempts = 0; picked.size < n && attempts < n * 32; attempts++) {
      const p = s.list[Math.floor(this.random() * s.list.length)];
      if (p && p !== self) picked.add(p);
    }
    return [...picked];
  }
}
