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
 *   integrityFetches(sessionId)    → HASH {playlist, segment, part} request counts
 *     (written by the worker's `stream:segments` consumer via `recordFetch`)
 */
import type { ValkeyClient } from "@commonair/service";
import type { SegmentFetch } from "@commonair/contracts/internal";
import { HeartbeatSample, type FetchSummary } from "./types.ts";

export const INTEGRITY_KEYS = {
  heartbeats: (sessionId: string) => `integrity:hb:${sessionId}`,
  fetches: (sessionId: string) => `integrity:fetch:${sessionId}`,
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

export async function recordFetch(valkey: ValkeyClient, fetch: Pick<SegmentFetch, "sid" | "kind">): Promise<void> {
  const key = INTEGRITY_KEYS.fetches(fetch.sid);
  await valkey.multi().hincrby(key, fetch.kind, 1).expire(key, EVIDENCE_TTL_SECONDS).exec();
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
  }
  const results = (await pipe.exec()) ?? [];
  sessionIds.forEach((id, i) => {
    const [hbErr, hb] = results[i * 2] ?? [null, []];
    const [fErr, f] = results[i * 2 + 1] ?? [null, {}];
    const beats = hbErr ? [] : parseBeats((hb as string[]) ?? []);
    const counters = fErr ? {} : ((f as Record<string, string>) ?? {});
    const hasCounters = Object.keys(counters).length > 0;
    out.set(id, {
      heartbeats: beats,
      fetches: hasCounters
        ? {
            playlists: toCount(counters.playlist) ?? 0,
            segments: toCount(counters.segment) ?? 0,
            parts: toCount(counters.part) ?? 0,
          }
        : null,
    });
  });
  return out;
}
