// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Relay issuance for DVR (ADR 0016 Amendment 2). Live issuance is sessions × what MediaMTX
 * produced in the minute (`issuance.ts`), and a relay serving only DVR pulls nothing live, so a
 * DVR-only session on a relay was issued nothing and its receipts could never verify.
 *
 * The DVR bound comes from the recording objects the origin itself served to relays: every DVR
 * object a relay serves it first pulls from `/relay-pull/dvr/`, so the pulls are a superset of
 * what any relay could serve. Per VOD the origin keeps a sorted set of the objects pulled (member
 * `<bytes>:<durationMs>:<file>`, score = the latest pull time in ms). A relay caches a DVR object
 * for at most the DVR window, so an object served in the minute B = [start, end) was pulled in
 * [start − window, end): only those count.
 *
 * One DVR session plays the recording at 1× (the player pins DVR to rate 1), so in a minute it
 * fetches at most `DVR_ISSUANCE_SPAN_SECONDS` of it: 60 s of playback plus a seek's buffer refill
 * and room-sync catch-up. Its allowance covers the span plus one segment (a run of playback starts
 * and ends inside a segment), plus the largest init segment: bytes are the densest objects
 * (bytes per media second) taken whole until they cover it, segments the shortest ones until
 * they cover it. Each is an upper bound on any set of objects that short, contiguous or not, so
 * it also holds for the short segments a stream restart leaves; for the recorder's uniform 4 s
 * segments it is the heaviest 31. The receipt verifier's tolerance applies on top.
 */
import { KEYS } from "@commonair/contracts/internal";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { Allowance } from "./issuance.ts";
import { noopMetrics, type OriginMetrics } from "./metrics.ts";

/** Media seconds one DVR session may fetch per minute: 60 s at 1× plus a 60 s buffer refill. */
export const DVR_ISSUANCE_SPAN_SECONDS = 120;
/** Pulls stay readable this long past the window, for the 5-minute recompute (as production's 20 min). */
export const DVR_PULLS_GRACE_MS = 20 * 60_000;
/**
 * How much longer than the window a relay may keep serving a pulled object: its segment cache life
 * is the cut playlist's span, which can overhang the window by the segment straddling its edge, and
 * is never under 30 s (`dvrMinExpiry` in `relay/internal/server/dvr.go`).
 */
export const DVR_PULLS_SLACK_MS = 60_000;

/** ZSET of the DVR objects relays pulled for one VOD. */
export const dvrPullsKey = KEYS.issuanceDvrPulls;

export interface DvrObject {
  file: string;
  bytes: number;
  /** The segment's EXTINF in ms; 0 for an init segment. */
  durationMs: number;
}

export const encodeDvrObject = (o: DvrObject) => `${o.bytes}:${o.durationMs}:${o.file}`;

/** Parse a member; null for anything malformed (never trusted to be well-formed). */
export function decodeDvrObject(member: string): DvrObject | null {
  const m = /^(\d{1,15}):(\d{1,9}):(.+)$/.exec(member);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { bytes: Number(m[1]), durationMs: Number(m[2]), file: m[3] };
}

/** One DVR session's allowance for a minute, from the objects pulled that could be served in it. */
export function dvrAllowance(objects: readonly DvrObject[], spanSeconds = DVR_ISSUANCE_SPAN_SECONDS): Allowance {
  // One entry per file: a re-pull of the same object is the same member, but be safe.
  const byFile = new Map<string, DvrObject>();
  for (const o of objects) {
    const prev = byFile.get(o.file);
    if (!prev || o.bytes > prev.bytes) byFile.set(o.file, o);
  }
  const media = [...byFile.values()].filter((o) => o.durationMs > 0);
  if (media.length === 0) return { segments: 0, bytes: 0 };
  const init = [...byFile.values()].filter((o) => o.durationMs === 0).reduce((max, o) => Math.max(max, o.bytes), 0);
  const need = spanSeconds * 1000 + media.reduce((max, o) => Math.max(max, o.durationMs), 0);
  // Fractional knapsack, last item whole: no set of objects lasting `need` or less weighs more.
  const dense = [...media].sort((a, b) => b.bytes / b.durationMs - a.bytes / a.durationMs);
  // No set lasting `need` or less has more objects than the shortest ones that cover it.
  const short = [...media].sort((a, b) => a.durationMs - b.durationMs);
  return {
    segments: takeUntil(short, need).length + (init > 0 ? 1 : 0),
    bytes: takeUntil(dense, need).reduce((sum, o) => sum + o.bytes, 0) + init,
  };
}

/** The leading objects of `sorted` whose durations first reach `needMs` (all of them if they never do). */
function takeUntil(sorted: readonly DvrObject[], needMs: number): DvrObject[] {
  let covered = 0;
  let n = 0;
  while (n < sorted.length && covered < needMs) covered += sorted[n++]?.durationMs ?? 0;
  return sorted.slice(0, n);
}

const RECORD_SCRIPT = `
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', '(' .. ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1`;

export interface DvrPullStoreOptions {
  valkey: Pick<ValkeyClient, "eval" | "zrangebyscore">;
  /** `DVR_MAX_WINDOW_SECONDS`: how long a relay may keep serving a pulled object. */
  windowSeconds: number;
  logger?: Logger;
  metrics?: OriginMetrics;
  /** Bound on unacknowledged writes while Valkey is slow. */
  maxPending?: number;
}

/** The relays' DVR pulls per VOD, aggregated across origin replicas in Valkey. */
export class DvrPullStore {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly metrics: OriginMetrics;

  constructor(private readonly opts: DvrPullStoreOptions) {
    this.metrics = opts.metrics ?? noopMetrics;
  }

  get windowMs(): number {
    return Math.max(0, this.opts.windowSeconds) * 1000;
  }

  /** How far before a minute a pull can still be served in it: the window plus the relay's slack. */
  get lookbackMs(): number {
    return this.windowMs + DVR_PULLS_SLACK_MS;
  }

  /** Count one whole DVR object served to a relay. Never awaited by a response. */
  record(vodId: string, obj: DvrObject, at: number): void {
    if (this.pending.size >= (this.opts.maxPending ?? 10_000)) {
      this.metrics.accountingDropped("dvr_pulls", 1);
      return;
    }
    const keep = this.lookbackMs + DVR_PULLS_GRACE_MS;
    const p = this.opts.valkey
      .eval(RECORD_SCRIPT, 1, dvrPullsKey(vodId), at, encodeDvrObject(obj), at - keep, keep)
      .catch((err: unknown) => {
        this.metrics.accountingDropped("dvr_pulls", 1);
        this.opts.logger?.warn("DVR pull record failed", { err });
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  /** The objects a relay could have served in [startMs, endMs): pulled in [startMs − lookback, endMs). */
  async servable(vodId: string, startMs: number, endMs: number): Promise<DvrObject[]> {
    const members = await this.opts.valkey.zrangebyscore(dvrPullsKey(vodId), startMs - this.lookbackMs, `(${endMs}`);
    return members.flatMap((m) => decodeDvrObject(m) ?? []);
  }
}
