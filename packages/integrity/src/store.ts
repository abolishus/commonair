// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ephemeral per-session evidence in Valkey: the recent heartbeat history and the
 * origin's request counters. Losing Valkey loses only this evidence (sessions then
 * score on what the database holds), never a verdict.
 *
 * CONTRACT-REQUEST: add these keys to `KEYS` in `@commonair/contracts/internal`:
 *   integrityHeartbeats(sessionId) → LIST of JSON HeartbeatSample, newest last
 *     (written by the API on every accepted heartbeat via `recordHeartbeat`)
 *   integrityFetches(sessionId)    → HASH {playlist, segment, part} request counts, plus
 *     HyperLogLogs of distinct segments / parts (written by the worker's
 *     `stream:segments` consumer via `recordFetches`)
 */
import type { ValkeyClient } from "@commonair/service";
import type { SegmentFetch } from "@commonair/contracts/internal";
import { HeartbeatSample, type FetchSummary } from "./types.ts";

export const INTEGRITY_KEYS = {
  heartbeats: (sessionId: string) => `integrity:hb:${sessionId}`,
  fetches: (sessionId: string) => `integrity:fetch:${sessionId}`,
  distinct: (sessionId: string, kind: "segment" | "part") => `integrity:fetch:${sessionId}:${kind}:u`,
} as const;

/** Enough history for the periodic-timing check with margin (10 s beats → 20 min). */
export const HEARTBEAT_HISTORY_LENGTH = 120;
export const EVIDENCE_TTL_SECONDS = 6 * 3600;

export async function recordHeartbeat(valkey: ValkeyClient, sessionId: string, sample: HeartbeatSample): Promise<void> {
  const key = INTEGRITY_KEYS.heartbeats(sessionId);
  await valkey
    .multi()
    .rpush(key, JSON.stringify(HeartbeatSample.parse(sample)))
    .ltrim(key, -HEARTBEAT_HISTORY_LENGTH, -1)
    .expire(key, EVIDENCE_TTL_SECONDS)
    .exec();
}

/**
 * One origin-served fetch for `recordFetches`. `object` identifies the media object (for
 * example `<rendition dir>/<file name>`, which carries the segment / part sequence number);
 * when given, segments and parts are counted as **distinct objects**, so re-requesting the
 * same segment cannot inflate the count.
 */
export interface FetchRecord {
  sid: SegmentFetch["sid"];
  kind: SegmentFetch["kind"];
  object?: string;
}

/** Single-fetch form of `recordFetches` (request counts only). */
export async function recordFetch(valkey: ValkeyClient, fetch: Pick<SegmentFetch, "sid" | "kind">): Promise<void> {
  await recordFetches(valkey, [fetch]);
}

/**
 * Record origin-served fetches for integrity scoring. Stable entry point for the worker's
 * `stream:segments` consumer: call it once per batch with the origin- and p2p-sourced
 * entries (not `relay` or `cdn`: those counters describe what the origin served the token).
 * One Valkey round trip per call; keys expire after `EVIDENCE_TTL_SECONDS`.
 *
 *   integrity:fetch:<sid>            HASH kind → request count
 *   integrity:fetch:<sid>:<kind>:u   HyperLogLog of distinct objects (segments/parts with `object`)
 */
export async function recordFetches(valkey: ValkeyClient, fetches: readonly FetchRecord[]): Promise<void> {
  if (fetches.length === 0) return;
  const counts = new Map<string, Map<string, number>>();
  const objects = new Map<string, string[]>();
  for (const f of fetches) {
    const byKind = counts.get(f.sid) ?? new Map<string, number>();
    byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
    counts.set(f.sid, byKind);
    if (f.object && f.kind !== "playlist") {
      const key = INTEGRITY_KEYS.distinct(f.sid, f.kind);
      objects.set(key, [...(objects.get(key) ?? []), f.object]);
    }
  }
  const pipe = valkey.multi();
  for (const [sid, byKind] of counts) {
    const key = INTEGRITY_KEYS.fetches(sid);
    for (const [kind, n] of byKind) pipe.hincrby(key, kind, n);
    pipe.expire(key, EVIDENCE_TTL_SECONDS);
  }
  for (const [key, objs] of objects) {
    pipe.pfadd(key, ...objs);
    pipe.expire(key, EVIDENCE_TTL_SECONDS);
  }
  await pipe.exec();
}

const parseBeats = (raw: readonly string[]): HeartbeatSample[] =>
  raw.flatMap((r) => {
    try {
      const parsed = HeartbeatSample.safeParse(JSON.parse(r));
      return parsed.success ? [parsed.data] : [];
    } catch {
      // A corrupt entry is dropped, not fatal: the rest of the history still counts.
      return [];
    }
  });

const toCount = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export interface SessionEvidence {
  heartbeats: HeartbeatSample[];
  /** Null when no counters exist for the session (fall back to the database counter). */
  fetches: Pick<FetchSummary, "playlists" | "segments" | "parts"> | null;
}

/** Read evidence for many sessions in one round trip. */
export async function readEvidence(
  valkey: ValkeyClient,
  sessionIds: readonly string[],
): Promise<Map<string, SessionEvidence>> {
  const out = new Map<string, SessionEvidence>();
  if (sessionIds.length === 0) return out;
  const pipe = valkey.pipeline();
  for (const id of sessionIds) {
    pipe.lrange(INTEGRITY_KEYS.heartbeats(id), 0, -1);
    pipe.hgetall(INTEGRITY_KEYS.fetches(id));
    pipe.pfcount(INTEGRITY_KEYS.distinct(id, "segment"));
    pipe.pfcount(INTEGRITY_KEYS.distinct(id, "part"));
  }
  const results = (await pipe.exec()) ?? [];
  const PER = 4;
  sessionIds.forEach((id, i) => {
    const [hbErr, hb] = results[i * PER] ?? [null, []];
    const [fErr, f] = results[i * PER + 1] ?? [null, {}];
    const [sErr, segDistinct] = results[i * PER + 2] ?? [null, 0];
    const [pErr, partDistinct] = results[i * PER + 3] ?? [null, 0];
    const beats = hbErr ? [] : parseBeats((hb as string[]) ?? []);
    const counters = fErr ? {} : ((f as Record<string, string>) ?? {});
    const hasCounters = Object.keys(counters).length > 0;
    // Distinct objects when they were recorded (never more than the requests seen).
    const pick = (requests: number, distinct: unknown, err: unknown) => {
      const d = err ? 0 : Number(distinct);
      return Number.isFinite(d) && d > 0 ? Math.min(requests, d) : requests;
    };
    out.set(id, {
      heartbeats: beats,
      fetches: hasCounters
        ? {
            playlists: toCount(counters.playlist) ?? 0,
            segments: pick(toCount(counters.segment) ?? 0, segDistinct, sErr),
            parts: pick(toCount(counters.part) ?? 0, partDistinct, pErr),
          }
        : null,
    });
  });
  return out;
}
