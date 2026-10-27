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
 *   For every directory d of b's channel (the source path and each rendition path),
 *   from the production all origin replicas recorded for B (production.ts; each media
 *   object counted once, in the minute it was first pulled from MediaMTX):
 *     objects(d) = full segments + LL-HLS parts + init sections of d
 *                  (relays count every fully delivered media object; playlists are excluded)
 *     bytes(d)   = max(full segment bytes, part bytes) + init bytes
 *                  (a player fetches parts at the live edge or whole segments when behind,
 *                   not both, so the larger of the two bounds one viewer's media bytes)
 *
 *   A session watches one directory at a time, so its allowance is the maximum:
 *     objAllow(b, B)   = max_d objects(d)
 *     bytesAllow(b, B) = max_d bytes(d)
 *
 *   relay_issuance(R, B):
 *     sessions      = Σ_b S(R, b, B)
 *     segmentTokens = Σ_b S(R, b, B) × objAllow(b, B)
 *     bytesIssued   = Σ_b S(R, b, B) × bytesAllow(b, B)
 *
 * Both are upper bounds on what R could legitimately have served in B; the receipt
 * verifier applies its own tolerance on top. Sessions on a broadcast with no recorded
 * production still count toward `sessions` but issue nothing.
 *
 * Every tick (60 s, 10 s after the minute boundary, and once on shutdown) recomputes
 * the last 5 closed minutes, so late production writes and heartbeats are picked up.
 * Rows are recomputed, not added, so recomputation is idempotent. A Valkey leader
 * lock makes exactly one replica compute per tick: the winner keeps it for its whole
 * lifetime (shorter than the tick interval), so a replica whose timer fires later in the
 * same minute finds it taken. It is released early only when the computation fails.
 */
import { and, eq, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { MINUTE_MS } from "./accounting.ts";
import { ISSUANCE_KEYS, type ChannelMinute, type DirProduction, type ProductionStore } from "./production.ts";

export interface Allowance {
  /** Media objects one session could fetch. */
  segments: number;
  bytes: number;
}

export const dirObjects = (d: DirProduction) => d.segments + d.parts + d.inits;
export const dirBytes = (d: DirProduction) => Math.max(d.segmentBytes, d.partBytes) + d.initBytes;

/** Per-session allowance for one broadcast-minute: the max over its directories. */
export function sessionAllowance(minute: ChannelMinute | undefined): Allowance {
  let segments = 0;
  let bytes = 0;
  for (const d of minute?.values() ?? []) {
    segments = Math.max(segments, dirObjects(d));
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

/** The last complete minute at `now`. */
export const issuanceBucket = (now: number) => Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS;

/** The closed minutes a tick at `now` recomputes, oldest first. */
export const recomputeBuckets = (now: number, lookback: number) =>
  Array.from({ length: lookback }, (_, i) => issuanceBucket(now) - (lookback - 1 - i) * MINUTE_MS);

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
  production: ProductionStore,
  bucketStartMs: number,
): Promise<IssuanceRow[]> {
  const start = new Date(bucketStartMs);
  const end = new Date(bucketStartMs + MINUTE_MS);
  const [counts, minute] = await Promise.all([relaySessionCounts(db, start, end), production.read(bucketStartMs)]);
  const rows = computeIssuance(counts, (path) => minute.get(path), start);
  await upsertIssuance(db, rows);
  return rows;
}

const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
/** After a successful tick: confirms the holder and keeps the lock until its TTL runs out. */
const HOLD_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return 1 end return 0`;

export interface IssuanceRunnerOptions {
  db: Executor;
  valkey: Pick<ValkeyClient, "set" | "eval">;
  production: ProductionStore;
  /** Closed minutes recomputed per tick. */
  lookbackMinutes?: number;
  /** Lock lifetime: longer than a tick takes, shorter than the tick interval. */
  lockTtlMs?: number;
  logger?: Logger;
  now?: () => number;
}

export class IssuanceRunner {
  private readonly id = crypto.randomUUID();
  private readonly now: () => number;

  constructor(private readonly opts: IssuanceRunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** One tick: null when another replica holds the lock, otherwise the rows written. */
  async tick(): Promise<IssuanceRow[] | null> {
    const lock = await this.opts.valkey.set(ISSUANCE_KEYS.lock, this.id, "PX", this.opts.lockTtlMs ?? 50_000, "NX");
    if (lock !== "OK") return null;
    let ok = false;
    try {
      const rows: IssuanceRow[] = [];
      for (const bucket of recomputeBuckets(this.now(), this.opts.lookbackMinutes ?? 5))
        rows.push(...(await runIssuance(this.opts.db, this.opts.production, bucket)));
      ok = true;
      return rows;
    } finally {
      // Releasing after success would let a replica whose timer fires later compute the same
      // tick again; a failed tick releases so another replica can retry it.
      await this.opts.valkey
        .eval(ok ? HOLD_SCRIPT : RELEASE_SCRIPT, 1, ISSUANCE_KEYS.lock, this.id)
        .catch((err: unknown) => this.opts.logger?.warn("issuance lock release failed", { err }));
    }
  }
}
