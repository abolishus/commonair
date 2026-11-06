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
 * DVR (ADR 0016 Amendment 2): a session that has played DVR (its mode is `dvr`, or it has
 * credited DVR seconds) may be fetching the recording instead of the live edge, which no
 * live production covers. Its allowance is the larger, per field, of the live one and
 * `dvrAllowance` over the recording objects relays pulled that could be served in B
 * (`dvr-issuance.ts`). Sessions that never rewound keep the live allowance alone.
 *
 * Every tick (60 s, 10 s after the minute boundary, and once on shutdown) recomputes
 * the last 5 closed minutes, so late production writes and heartbeats are picked up.
 * Rows are recomputed, not added, so recomputation is idempotent. A Valkey leader
 * lock makes exactly one replica compute per tick: the winner keeps it for its whole
 * lifetime (shorter than the tick interval), so a replica whose timer fires later in the
 * same minute finds it taken. It is released early only when the computation fails.
 */
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { schema } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { MINUTE_MS } from "./accounting.ts";
import { dvrAllowance, type DvrPullStore } from "./dvr-issuance.ts";
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
  /** Of `sessions`, those that have played DVR (mode `dvr` or `dvr_seconds > 0`). */
  dvrSessions?: number;
}

export interface IssuanceRow {
  relayId: string;
  bucketStart: Date;
  sessions: number;
  segmentTokens: number;
  bytesIssued: number;
}

/** The formula above, as a pure function. `dvr` gives a broadcast's DVR allowance for the minute. */
export function computeIssuance(
  counts: RelaySessionCount[],
  production: (path: string) => ChannelMinute | undefined,
  bucketStart: Date,
  dvr: (broadcastId: string) => Allowance | undefined = () => undefined,
): IssuanceRow[] {
  const byRelay = new Map<string, IssuanceRow>();
  for (const c of counts) {
    if (c.sessions <= 0) continue;
    let row = byRelay.get(c.relayId);
    if (!row) {
      row = { relayId: c.relayId, bucketStart, sessions: 0, segmentTokens: 0, bytesIssued: 0 };
      byRelay.set(c.relayId, row);
    }
    const live = sessionAllowance(c.path ? production(c.path) : undefined);
    const rewound = Math.min(c.sessions, Math.max(0, c.dvrSessions ?? 0));
    const fromDvr = rewound > 0 && c.broadcastId ? dvr(c.broadcastId) : undefined;
    const either = {
      segments: Math.max(live.segments, fromDvr?.segments ?? 0),
      bytes: Math.max(live.bytes, fromDvr?.bytes ?? 0),
    };
    row.sessions += c.sessions;
    row.segmentTokens += (c.sessions - rewound) * live.segments + rewound * either.segments;
    row.bytesIssued += (c.sessions - rewound) * live.bytes + rewound * either.bytes;
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
      dvrSessions: sql<number>`(count(*) filter (where ${ps.playbackMode} = 'dvr' or ${ps.dvrSeconds} > 0))::int`,
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
  return rows.flatMap((r) =>
    r.relayId ? [{ ...r, relayId: r.relayId, sessions: Number(r.sessions), dvrSessions: Number(r.dvrSessions) }] : [],
  );
}

/**
 * Each broadcast's DVR allowance for the minute: over the broadcast's VODs (one, unless the
 * recording was split), the largest `dvrAllowance` of the objects relays pulled that could be
 * served in it. VOD status is not filtered: a recompute after the stream ended must give the
 * same answer as the tick during it.
 */
export async function dvrAllowances(
  db: Executor,
  pulls: DvrPullStore,
  broadcastIds: readonly string[],
  start: Date,
  end: Date,
): Promise<Map<string, Allowance>> {
  const out = new Map<string, Allowance>();
  if (broadcastIds.length === 0) return out;
  const v = schema.vods;
  const vods = await db
    .select({ id: v.id, broadcastId: v.broadcastId })
    .from(v)
    .where(inArray(v.broadcastId, [...broadcastIds]));
  await Promise.all(
    vods.map(async ({ id, broadcastId }) => {
      if (!broadcastId) return;
      const allow = dvrAllowance(await pulls.servable(id, start.getTime(), end.getTime()));
      const prev = out.get(broadcastId);
      out.set(broadcastId, {
        segments: Math.max(prev?.segments ?? 0, allow.segments),
        bytes: Math.max(prev?.bytes ?? 0, allow.bytes),
      });
    }),
  );
  return out;
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
  dvrPulls?: DvrPullStore,
): Promise<IssuanceRow[]> {
  const start = new Date(bucketStartMs);
  const end = new Date(bucketStartMs + MINUTE_MS);
  const [counts, minute] = await Promise.all([relaySessionCounts(db, start, end), production.read(bucketStartMs)]);
  const rewound = [
    ...new Set(counts.flatMap((c) => ((c.dvrSessions ?? 0) > 0 && c.broadcastId ? [c.broadcastId] : []))),
  ];
  const dvr = dvrPulls ? await dvrAllowances(db, dvrPulls, rewound, start, end) : new Map<string, Allowance>();
  const rows = computeIssuance(
    counts,
    (path) => minute.get(path),
    start,
    (b) => dvr.get(b),
  );
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
  /** Relays' DVR pulls (ADR 0016 Amendment 2); absent = DVR sessions get the live allowance only. */
  dvrPulls?: DvrPullStore;
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
        rows.push(...(await runIssuance(this.opts.db, this.opts.production, bucket, this.opts.dvrPulls)));
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
