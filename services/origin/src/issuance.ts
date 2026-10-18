// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay issuance: the ground truth relay receipts are cross-checked against.
 *
 * The origin cannot see what a relay serves (viewers fetch from the relay), so
 * issuance is computed from what the origin *issued*: sessions it assigned to the
 * relay that are alive, and what MediaMTX produced while they were.
 *
 * For relay R and the minute bucket B = [start, start + 60 s):
 *
 *   S(R, b, B)  = playback sessions with relayId = R, assignedSource = relay, watching
 *                 broadcast b, alive in B: startedAt < end, lastHeartbeatAt ≥ start,
 *                 and not ended before start.
 *
 *   For every directory d of b's channel (the source path and each rendition path):
 *     seg(d)   = distinct full media segments first listed in d's media playlists in B
 *                (all tracks of d: a viewer of d fetches its video and audio)
 *     bytes(d) = max(bytes of full segments + init sections first pulled in B,
 *                    bytes of LL-HLS parts first pulled in B)
 *                (a player fetches parts at the live edge or whole segments when behind,
 *                 not both, so the larger of the two bounds one viewer's needs)
 *
 *   A session watches one directory at a time, so its allowance is the maximum:
 *     segAllow(b, B)   = max_d seg(d)
 *     bytesAllow(b, B) = max_d bytes(d)
 *
 *   relay_issuance(R, B):
 *     sessions      = Σ_b S(R, b, B)
 *     segmentTokens = Σ_b S(R, b, B) × segAllow(b, B)
 *     bytesIssued   = Σ_b S(R, b, B) × bytesAllow(b, B)
 *
 * bytesIssued is an upper bound on what R could legitimately have served in B; the
 * receipt verifier applies its own tolerance on top. Sessions on a broadcast with no
 * recorded production (origin restarted mid-minute, channel just went offline) still
 * count toward `sessions` but issue nothing.
 *
 * The origin runs `runIssuance` for the previous minute on a 60 s timer (after a
 * grace period so heartbeats landing just after the minute are counted). Rows are
 * recomputed, not added, so re-running a bucket is idempotent.
 */
import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import { MINUTE_MS, type ChannelMinute, type DirProduction } from "./accounting.ts";

export interface Allowance {
  segments: number;
  bytes: number;
}

export function dirBytes(d: DirProduction): number {
  return Math.max(d.segmentBytes, d.partBytes);
}

/** Per-session allowance for one broadcast-minute: the max over its directories. */
export function sessionAllowance(minute: ChannelMinute | undefined): Allowance {
  let segments = 0;
  let bytes = 0;
  for (const d of minute?.values() ?? []) {
    segments = Math.max(segments, d.segments);
    bytes = Math.max(bytes, dirBytes(d));
  }
  return { segments, bytes };
}

export interface RelaySessionCount {
  relayId: string;
  /** Null when the session was not bound to a broadcast. */
  broadcastId: string | null;
  /** MediaMTX path of the broadcast (`live/<slug>`), the production key. */
  path: string | null;
  sessions: number;
}

export interface IssuanceRow {
  relayId: string;
  bucketStart: Date;
  sessions: number;
  segmentTokens: number;
  bytesIssued: number;
}

/** The formula above, as a pure function. */
export function computeIssuance(
  counts: RelaySessionCount[],
  production: (path: string) => ChannelMinute | undefined,
  bucketStart: Date,
): IssuanceRow[] {
  const byRelay = new Map<string, IssuanceRow>();
  for (const c of counts) {
    if (c.sessions <= 0) continue;
    let row = byRelay.get(c.relayId);
    if (!row) {
      row = { relayId: c.relayId, bucketStart, sessions: 0, segmentTokens: 0, bytesIssued: 0 };
      byRelay.set(c.relayId, row);
    }
    const allow = sessionAllowance(c.path ? production(c.path) : undefined);
    row.sessions += c.sessions;
    row.segmentTokens += c.sessions * allow.segments;
    row.bytesIssued += c.sessions * allow.bytes;
  }
  return [...byRelay.values()].sort((a, b) => a.relayId.localeCompare(b.relayId));
}

/** The bucket a run at `now` computes: the last complete minute. */
export const issuanceBucket = (now: number) => Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS;

export async function relaySessionCounts(db: Executor, start: Date, end: Date): Promise<RelaySessionCount[]> {
  const ps = schema.playbackSessions;
  const b = schema.broadcasts;
  const rows = await db
    .select({
      relayId: ps.relayId,
      broadcastId: ps.broadcastId,
      path: b.path,
      sessions: sql<number>`count(*)::int`,
    })
    .from(ps)
    .leftJoin(b, eq(b.id, ps.broadcastId))
    .where(
      and(
        isNotNull(ps.relayId),
        eq(ps.assignedSource, "relay"),
        lt(ps.startedAt, end),
        gte(ps.lastHeartbeatAt, start),
        or(isNull(ps.endedAt), gte(ps.endedAt, start)),
      ),
    )
    .groupBy(ps.relayId, ps.broadcastId, b.path);
  return rows.flatMap((r) => (r.relayId ? [{ ...r, relayId: r.relayId, sessions: Number(r.sessions) }] : []));
}

export async function upsertIssuance(db: Executor, rows: IssuanceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const t = schema.relayIssuance;
  await db
    .insert(t)
    .values(rows)
    .onConflictDoUpdate({
      target: [t.relayId, t.bucketStart],
      set: {
        sessions: sql`excluded.sessions`,
        segmentTokens: sql`excluded.segment_tokens`,
        bytesIssued: sql`excluded.bytes_issued`,
      },
    });
}

/** Compute and store issuance for the minute starting at `bucketStartMs`. */
export async function runIssuance(
  db: Executor,
  production: (path: string, bucketStartMs: number) => ChannelMinute | undefined,
  bucketStartMs: number,
): Promise<IssuanceRow[]> {
  const start = new Date(bucketStartMs);
  const end = new Date(bucketStartMs + MINUTE_MS);
  const counts = await relaySessionCounts(db, start, end);
  const rows = computeIssuance(counts, (path) => production(path, bucketStartMs), start);
  await upsertIssuance(db, rows);
  return rows;
}
