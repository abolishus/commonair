// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-side P2P evidence (ADR 0005, decision 4). Whether a viewer runs the P2P loader is client
 * input, so the reduced HTTP share is granted only to sessions the tracker saw actually exchange
 * signalling with a peer elsewhere. Evidence is per session, never per swarm: announcing into a
 * swarm that honest viewers populate earns nothing. The tracker (`services/tracker`) is the only
 * writer of these keys; integrity only reads them:
 *
 *   KEYS.p2pPeer(sid)              HASH swarm, net (HMAC of the /24 or /48), first, last, announces
 *   KEYS.p2pLinks(sid)             ZSET peer net → last completed offer/answer exchange (epoch ms)
 *   KEYS.p2pChannelNet(ch, net)    ZSET sessionId → last announce (epoch ms) to any swarm of `ch`
 *                                  from network `net`; leaving a swarm never removes a member
 *
 * A session is **evidenced** at window end `t` (now, or when an ended session ended) when all hold,
 * with `since = t − windowMs`:
 *
 *   1. its peer hash says it announced at or after `since`, to a swarm of its own channel (the
 *      swarm id's `<channelId>:` prefix);
 *   2. its `p2pLinks` holds, at or after `since`, at least `minLinkedNetworks` distinct networks
 *      other than its own `net` (a link to its own network proves nothing);
 *   3. at most `maxSessionsPerNetwork` sessions on its `net` announced to its channel at or after
 *      `since` (`ZCOUNT p2pChannelNet(channel, net) since +inf`, itself included). Counted per
 *      channel, not per swarm: clients choose info hashes, so a farm could otherwise split into
 *      private swarms;
 *   4. at least one linked network from (2) is itself within that cap, so two farm networks over
 *      the cap cannot vouch for each other.
 *
 * The counts are not bounded above by an ended session's end: the ZSET score is each member's
 * *last* announce, so dropping members scored after the end would drop every peer that kept
 * watching and undercount the farm. Counting them can only withhold the reduced share.
 *
 * Valkey errors never throw: the affected sessions are not evidenced and the error is counted.
 */
import { KEYS, P2P_EVIDENCE } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";
import type { P2pEvidence } from "./types.ts";

export interface P2pRule {
  windowMs: number;
  minLinkedNetworks: number;
  maxSessionsPerNetwork: number;
}
export const P2P_RULE: P2pRule = {
  windowMs: P2P_EVIDENCE.windowMs,
  minLinkedNetworks: P2P_EVIDENCE.minLinkedNetworks,
  maxSessionsPerNetwork: P2P_EVIDENCE.maxSessionsPerNetwork,
};

/** One session's `KEYS.p2pPeer` hash, parsed. */
export interface P2pPeer {
  swarm: string;
  net: string;
  first: number;
  last: number;
  announces: number;
}

/** One `KEYS.p2pLinks` entry: a peer network and the last completed exchange with it. */
export interface P2pLink {
  net: string;
  at: number;
}

export interface P2pSessionRef {
  id: string;
  channelId: string;
  /** Window end for this session (epoch ms): now, or when an ended session ended. */
  at: number;
}

export const NOT_EVIDENCED: P2pEvidence = Object.freeze({
  evidenced: false,
  linkedNetworks: 0,
  linkedWithinCap: 0,
  sameNetworkPeers: 0,
  announces: 0,
});

const finite = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseP2pPeer(raw: Record<string, string> | null | undefined): P2pPeer | null {
  if (!raw) return null;
  const last = finite(raw.last);
  if (!raw.swarm || !raw.net || last === null) return null;
  return {
    swarm: raw.swarm,
    net: raw.net,
    first: finite(raw.first) ?? last,
    last,
    announces: Math.max(0, Math.trunc(finite(raw.announces) ?? 0)),
  };
}

/** Parse a `WITHSCORES` reply (`[member, score, member, score, …]`) into links. */
export function parseLinks(flat: unknown): P2pLink[] {
  const out: P2pLink[] = [];
  if (!Array.isArray(flat)) return out;
  for (let j = 0; j + 1 < flat.length; j += 2) {
    const at = Number(flat[j + 1]);
    if (Number.isFinite(at)) out.push({ net: String(flat[j]), at });
  }
  return out;
}

export const swarmOfChannel = (swarm: string, channelId: string) => swarm.startsWith(`${channelId}:`);

/** Whether a peer hash makes the session a candidate (rule 1). */
export function isP2pCandidate(peer: P2pPeer | null, s: P2pSessionRef, rule: P2pRule = P2P_RULE): boolean {
  return peer !== null && peer.last >= s.at - rule.windowMs && swarmOfChannel(peer.swarm, s.channelId);
}

/** Distinct networks other than the session's own it exchanged with in the window (rule 2). */
export function linkedNetworks(peer: P2pPeer, links: readonly P2pLink[], s: P2pSessionRef, rule: P2pRule = P2P_RULE) {
  const since = s.at - rule.windowMs;
  const nets = new Set<string>();
  for (const l of links) if (l.at >= since && l.net !== peer.net) nets.add(l.net);
  return [...nets];
}

/**
 * The evidence predicate. `netCounts` maps a network to its in-window announcers on the session's
 * channel (`p2pChannelNet` ZCOUNT); a network missing from it (the read failed) is treated as over
 * the cap.
 */
export function p2pEvidenceFor(
  s: P2pSessionRef,
  peer: P2pPeer | null,
  links: readonly P2pLink[],
  netCounts: ReadonlyMap<string, number>,
  rule: P2pRule = P2P_RULE,
): P2pEvidence {
  if (!peer || !isP2pCandidate(peer, s, rule)) return NOT_EVIDENCED;
  const within = (net: string) => {
    const n = netCounts.get(net);
    return n !== undefined && n <= rule.maxSessionsPerNetwork;
  };
  const linked = linkedNetworks(peer, links, s, rule);
  const linkedWithinCap = linked.filter(within).length;
  return {
    evidenced: linked.length >= rule.minLinkedNetworks && within(peer.net) && linkedWithinCap >= 1,
    linkedNetworks: linked.length,
    linkedWithinCap,
    sameNetworkPeers: netCounts.get(peer.net) ?? 0,
    announces: peer.announces,
  };
}

export interface P2pEvidenceResult {
  evidence: Map<string, P2pEvidence>;
  /** Valkey commands (or whole round trips, counted once per session) that failed. */
  errors: number;
}

type PipelineResult = [Error | null, unknown][] | null;

/**
 * Read P2P evidence for a batch of sessions in three pipelined round trips at most: peer hashes;
 * candidates' links plus their own network's channel count; the channel counts of their linked
 * networks. Each `p2pChannelNet` count is read once per batch. Sessions missing from the result
 * were not evidenced.
 */
export async function readP2pEvidence(
  valkey: ValkeyClient,
  sessions: readonly P2pSessionRef[],
  rule: P2pRule = P2P_RULE,
): Promise<P2pEvidenceResult> {
  const evidence = new Map<string, P2pEvidence>();
  let errors = 0;
  if (sessions.length === 0) return { evidence, errors };
  const run = async (build: (p: ReturnType<ValkeyClient["pipeline"]>) => void, n: number): Promise<PipelineResult> => {
    try {
      const p = valkey.pipeline();
      build(p);
      return (await p.exec()) ?? null;
    } catch {
      errors += n;
      return null;
    }
  };
  // In-window ZCOUNTs keyed by `p2pChannelNet` key and window start, each read once per batch.
  // A failed one stays absent, which the predicate treats as over the cap.
  const counts = new Map<string, number>();
  type CountReq = { key: string; channelId: string; net: string; since: number };
  const req = (s: P2pSessionRef, net: string): CountReq => {
    const since = s.at - rule.windowMs;
    return { key: `${KEYS.p2pChannelNet(s.channelId, net)}@${since}`, channelId: s.channelId, net, since };
  };
  const unique = (rs: CountReq[]) => [...new Map(rs.map((r) => [r.key, r])).values()];
  const queueCounts = (p: ReturnType<ValkeyClient["pipeline"]>, rs: readonly CountReq[]) => {
    for (const r of rs) p.zcount(KEYS.p2pChannelNet(r.channelId, r.net), r.since, "+inf");
  };
  const storeCounts = (rs: readonly CountReq[], raw: [Error | null, unknown][], offset: number) => {
    rs.forEach((r, i) => {
      const [err, v] = raw[offset + i] ?? [null, null];
      const c = Number(v);
      if (err || v === null || !Number.isFinite(c)) errors++;
      else counts.set(r.key, c);
    });
  };
  const countsFor = (s: P2pSessionRef, nets: readonly string[]) => {
    const m = new Map<string, number>();
    for (const net of nets) {
      const c = counts.get(req(s, net).key);
      if (c !== undefined) m.set(net, c);
    }
    return m;
  };

  // 1. Peer hashes.
  const peersRaw = await run((p) => {
    for (const s of sessions) p.hgetall(KEYS.p2pPeer(s.id));
  }, sessions.length);
  if (!peersRaw) return { evidence, errors };
  const candidates: { s: P2pSessionRef; peer: P2pPeer }[] = [];
  sessions.forEach((s, i) => {
    const [err, raw] = peersRaw[i] ?? [null, null];
    if (err) {
      errors++;
      return;
    }
    const peer = parseP2pPeer(raw as Record<string, string> | null);
    if (peer && isP2pCandidate(peer, s, rule)) candidates.push({ s, peer });
  });
  if (candidates.length === 0) return { evidence, errors };

  // 2. Each candidate's in-window links, and its own network's channel count (rule 3).
  const own = unique(candidates.map(({ s, peer }) => req(s, peer.net)));
  const readRaw = await run((p) => {
    for (const { s } of candidates) p.zrangebyscore(KEYS.p2pLinks(s.id), s.at - rule.windowMs, "+inf", "WITHSCORES");
    queueCounts(p, own);
  }, candidates.length);
  if (!readRaw) return { evidence, errors };
  storeCounts(own, readRaw, candidates.length);
  const linked: { s: P2pSessionRef; peer: P2pPeer; links: P2pLink[]; nets: string[] }[] = [];
  candidates.forEach(({ s, peer }, i) => {
    const [err, raw] = readRaw[i] ?? [null, []];
    if (err) {
      errors++;
      return;
    }
    const links = parseLinks(raw);
    const nets = linkedNetworks(peer, links, s, rule);
    const ownCount = countsFor(s, [peer.net]).get(peer.net);
    if (ownCount === undefined) return; // count failed: not evidenced
    // Too few links, or its own network over the cap: the linked networks cannot change that.
    if (nets.length < rule.minLinkedNetworks || ownCount > rule.maxSessionsPerNetwork) {
      evidence.set(s.id, p2pEvidenceFor(s, peer, links, countsFor(s, [peer.net]), rule));
    } else linked.push({ s, peer, links, nets });
  });
  if (linked.length === 0) return { evidence, errors };

  // 3. The channel counts of the linked networks (rule 4).
  const wanted = unique(linked.flatMap(({ s, nets }) => nets.map((net) => req(s, net)))).filter(
    (r) => !counts.has(r.key),
  );
  if (wanted.length > 0) {
    const raw = await run((p) => queueCounts(p, wanted), linked.length);
    if (!raw) return { evidence, errors };
    storeCounts(wanted, raw, 0);
  }
  for (const { s, peer, links, nets } of linked) {
    evidence.set(s.id, p2pEvidenceFor(s, peer, links, countsFor(s, [peer.net, ...nets]), rule));
  }
  return { evidence, errors };
}
