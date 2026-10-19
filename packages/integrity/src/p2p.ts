// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-side P2P evidence (ADR 0005). Whether a viewer runs the P2P loader is client input, so
 * the reduced HTTP share is granted only to sessions the tracker saw take part in a real swarm.
 * The tracker (`services/tracker`) is the only writer of these keys; integrity only reads them:
 *
 *   KEYS.p2pPeer(sid)     HASH swarm, net (HMAC of the /24 or /48), first, last (epoch ms), announces
 *   KEYS.p2pSwarm(swarm)  ZSET sessionId → last announce (epoch ms); swarm = `<channelId>:<infoHash>`
 *
 * A session is **evidenced** at window end `t` when
 *
 *   1. its peer hash says it announced at or after `t − windowMs`,
 *   2. its swarm belongs to the session's own channel (the swarm id's `<channelId>:` prefix), and
 *   3. the swarm's members that announced at or after `t − windowMs` (itself included) span at
 *      least `minSwarmNetworks` distinct networks. Members whose peer hash names another channel's
 *      swarm, or has no network, are ignored.
 *
 * At most `P2P_SWARM_MEMBER_CAP` members are read per swarm, the most recent announcers first.
 * Two networks are enough to evidence a swarm, so a sample suffices for honest swarms; a farm that
 * floods one swarm with more than the cap of fresh single-network sessions can push honest members
 * out of the sample, which only withholds the reduced share (the session is judged like any other).
 *
 * Valkey errors never throw: the affected sessions are not evidenced and the error is counted.
 */
import { KEYS, P2P_EVIDENCE } from "@commonair/contracts/internal";
import type { ValkeyClient } from "@commonair/service";
import type { P2pEvidence } from "./types.ts";

/** Members read per swarm (most recent announcers first). */
export const P2P_SWARM_MEMBER_CAP = 500;

export interface P2pRule {
  windowMs: number;
  minSwarmNetworks: number;
  memberCap: number;
}
export const P2P_RULE: P2pRule = {
  windowMs: P2P_EVIDENCE.windowMs,
  minSwarmNetworks: P2P_EVIDENCE.minSwarmNetworks,
  memberCap: P2P_SWARM_MEMBER_CAP,
};

/** One session's `KEYS.p2pPeer` hash, parsed. */
export interface P2pPeer {
  swarm: string;
  net: string;
  first: number;
  last: number;
  announces: number;
}

/** A swarm member as read for the evidence check. */
export interface P2pMember {
  sessionId: string;
  /** Last announce in this swarm (the ZSET score), epoch ms. */
  at: number;
  /** From the member's peer hash; null when it expired or is incomplete. */
  net: string | null;
  swarm: string | null;
}

export const NOT_EVIDENCED: P2pEvidence = Object.freeze({ evidenced: false, swarmNetworks: 0, announces: 0 });

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

export const swarmOfChannel = (swarm: string, channelId: string) => swarm.startsWith(`${channelId}:`);

/** Whether a peer hash makes the session a candidate at window end `t` (rules 1 and 2). */
export function isP2pCandidate(peer: P2pPeer | null, channelId: string, t: number, rule: P2pRule = P2P_RULE): boolean {
  return peer !== null && peer.last >= t - rule.windowMs && swarmOfChannel(peer.swarm, channelId);
}

/**
 * The evidence predicate. `members` are the swarm's members in the order read (most recent first);
 * only the first `rule.memberCap` are considered.
 */
export function p2pEvidenceFor(
  peer: P2pPeer | null,
  channelId: string,
  members: readonly P2pMember[],
  t: number,
  rule: P2pRule = P2P_RULE,
): P2pEvidence {
  if (!peer || !isP2pCandidate(peer, channelId, t, rule)) return NOT_EVIDENCED;
  const since = t - rule.windowMs;
  const nets = new Set<string>([peer.net]);
  for (const m of members.slice(0, rule.memberCap)) {
    if (m.at < since || m.net === null || m.swarm === null || !swarmOfChannel(m.swarm, channelId)) continue;
    nets.add(m.net);
  }
  return {
    evidenced: nets.size >= rule.minSwarmNetworks,
    swarmNetworks: nets.size,
    announces: peer.announces,
  };
}

export interface P2pSessionRef {
  id: string;
  channelId: string;
  /** Window end for this session (epoch ms): now, or when an ended session ended. */
  at: number;
}

export interface P2pEvidenceResult {
  evidence: Map<string, P2pEvidence>;
  /** Valkey commands (or whole round trips, counted once per session) that failed. */
  errors: number;
}

type PipelineResult = [Error | null, unknown][] | null;

/**
 * Read P2P evidence for a batch of sessions: three pipelined round trips at most (peer hashes,
 * candidate swarms, swarm members' networks). Sessions missing from the result were not evidenced.
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
    if (peer && isP2pCandidate(peer, s.channelId, s.at, rule)) candidates.push({ s, peer });
  });
  if (candidates.length === 0) return { evidence, errors };

  // 2. In-window members of each candidate swarm, most recent first (one read per swarm, from the
  // earliest window start any of its sessions needs).
  const since = new Map<string, number>();
  for (const { s, peer } of candidates) {
    since.set(peer.swarm, Math.min(since.get(peer.swarm) ?? Infinity, s.at - rule.windowMs));
  }
  const swarms = [...since.keys()];
  const membersRaw = await run((p) => {
    for (const sw of swarms) {
      p.zrevrangebyscore(KEYS.p2pSwarm(sw), "+inf", since.get(sw) ?? 0, "WITHSCORES", "LIMIT", 0, rule.memberCap);
    }
  }, candidates.length);
  if (!membersRaw) return { evidence, errors };
  const scored = new Map<string, { sessionId: string; at: number }[]>();
  const failedSwarms = new Set<string>();
  swarms.forEach((sw, i) => {
    const [err, raw] = membersRaw[i] ?? [null, []];
    if (err) {
      failedSwarms.add(sw);
      errors++;
      return;
    }
    const flat = (raw as string[]) ?? [];
    const list: { sessionId: string; at: number }[] = [];
    for (let j = 0; j + 1 < flat.length; j += 2) {
      const at = Number(flat[j + 1]);
      if (Number.isFinite(at)) list.push({ sessionId: String(flat[j]), at });
    }
    scored.set(sw, list);
  });

  // 3. Each member's network and swarm (deduplicated across swarms).
  const memberIds = [...new Set([...scored.values()].flatMap((l) => l.map((m) => m.sessionId)))];
  const netsRaw =
    memberIds.length > 0
      ? await run((p) => {
          for (const id of memberIds) p.hmget(KEYS.p2pPeer(id), "net", "swarm");
        }, candidates.length)
      : [];
  if (!netsRaw) return { evidence, errors };
  const info = new Map<string, { net: string | null; swarm: string | null }>();
  memberIds.forEach((id, i) => {
    const [err, raw] = netsRaw[i] ?? [null, null];
    if (err) {
      errors++;
      return;
    }
    const [net, swarm] = (raw as (string | null)[] | null) ?? [null, null];
    info.set(id, { net: net || null, swarm: swarm || null });
  });

  for (const { s, peer } of candidates) {
    if (failedSwarms.has(peer.swarm)) continue;
    const members = (scored.get(peer.swarm) ?? []).map((m): P2pMember => ({
      ...m,
      ...(info.get(m.sessionId) ?? { net: null, swarm: null }),
    }));
    evidence.set(s.id, p2pEvidenceFor(peer, s.channelId, members, s.at, rule));
  }
  return { evidence, errors };
}
