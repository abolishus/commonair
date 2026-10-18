// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure aggregation of segment-fetch entries into per-minute egress and per-session counters. */
import type { DELIVERY_SOURCES } from "@commonair/contracts/enums";
import { SegmentFetch } from "@commonair/contracts/internal";

type Source = (typeof DELIVERY_SOURCES)[number];

export interface EgressRow {
  broadcastId: string;
  bucketStart: Date;
  source: Source;
  bytes: number;
  requests: number;
}
export interface SessionIncrement {
  sessionId: string;
  segments: number;
  bytesHttp: number;
}
export interface Aggregate {
  egress: EgressRow[];
  sessions: SessionIncrement[];
}

/** Sources whose bytes leave our (or a member relay's / the CDN's) servers over HTTP. */
const HTTP_SOURCES: ReadonlySet<Source> = new Set(["origin", "relay", "cdn"]);

export const MINUTE_MS = 60_000;
export const minuteBucket = (atMs: number) => new Date(Math.floor(atMs / MINUTE_MS) * MINUTE_MS);

/** Decode stream entry fields ([k, v, k, v, …]) into a SegmentFetch, or null when malformed. */
export function parseEntry(fields: readonly string[], nowMs = Date.now()): SegmentFetch | null {
  const obj: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) obj[fields[i] as string] = fields[i + 1] as string;
  const r = SegmentFetch.safeParse(obj);
  if (!r.success) return null;
  // A timestamp far outside "now" is a bug or forgery; one such entry must not fail a whole batch
  // (an out-of-range Date would) or land in a bucket nobody will ever look at.
  if (r.data.at < nowMs - MAX_AGE_MS || r.data.at > nowMs + MAX_SKEW_MS) return null;
  return r.data;
}

/** Accepted `at` window: entries older than a day or more than 5 min in the future are dropped. */
export const MAX_AGE_MS = 24 * 3_600_000;
export const MAX_SKEW_MS = 5 * MINUTE_MS;

/**
 * Fold fetches into rows. Egress counts every request (playlists included: they are
 * bytes we serve) under the session's broadcast; sessions without a broadcast are
 * not attributable and only update session counters. `segmentsFetched` counts
 * media segments, not playlists or LL-HLS parts.
 */
export function aggregate(
  fetches: readonly SegmentFetch[],
  broadcastOf: (sessionId: string) => string | null | undefined,
): Aggregate {
  const egress = new Map<string, EgressRow>();
  const sessions = new Map<string, SessionIncrement>();
  for (const f of fetches) {
    const broadcastId = broadcastOf(f.sid);
    if (broadcastId) {
      const bucketStart = minuteBucket(f.at);
      const key = `${broadcastId}|${bucketStart.getTime()}|${f.src}`;
      const row = egress.get(key) ?? { broadcastId, bucketStart, source: f.src, bytes: 0, requests: 0 };
      row.bytes += f.bytes;
      row.requests += 1;
      egress.set(key, row);
    }
    const s = sessions.get(f.sid) ?? { sessionId: f.sid, segments: 0, bytesHttp: 0 };
    if (f.kind === "segment") s.segments += 1;
    if (HTTP_SOURCES.has(f.src)) s.bytesHttp += f.bytes;
    sessions.set(f.sid, s);
  }
  return {
    egress: [...egress.values()],
    sessions: [...sessions.values()].filter((s) => s.segments > 0 || s.bytesHttp > 0),
  };
}
