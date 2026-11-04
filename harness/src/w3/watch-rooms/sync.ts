// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How the `watch-room` scenario measures sync (decision (r)), pure so it is unit-tested. Each
 * member's page reports its playhead to chat every 2 s (`room.sync {playheadWallclock, mode}` on
 * the room's socket); Playwright sees each frame as it leaves (`framesent`). A playing member's
 * playhead advances with real time, so a report sent at `sentAt` stands for `pdt + (t - sentAt)`
 * at any later `t`. The room's delta at `t` is the spread of those extrapolations across members;
 * the step's figure is the median over several instants, so one late frame on a loaded runner does
 * not decide it.
 */

export interface PlayheadSample {
  /** Harness clock when the frame left the page (epoch ms). */
  sentAt: number;
  /** The reported PDT under the playhead (epoch ms). */
  pdt: number;
  mode: "live" | "dvr";
  /**
   * Batch 8: the reported live edge (`edgeWallclock`, epoch ms); null when the frame says null (DVR,
   * or unknown), absent when the frame has no such field (a player before batch 8).
   */
  edge?: number | null;
}

/** A `room.sync` client frame's playhead (and edge, when it carries the field), or null for any other frame. */
export function syncFrameOf(
  payload: string | Buffer,
  roomId: string,
): { pdt: number; mode: "live" | "dvr"; edge?: number | null } | null {
  const text = typeof payload === "string" ? payload : payload.toString("utf8");
  let frame: unknown;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof frame !== "object" || frame === null) return null;
  const f = frame as Record<string, unknown>;
  if (f.op !== "room.sync" || f.roomId !== roomId || typeof f.playheadWallclock !== "string") return null;
  const pdt = Date.parse(f.playheadWallclock);
  if (!Number.isFinite(pdt)) return null;
  const mode = f.mode === "dvr" ? "dvr" : "live";
  if (!("edgeWallclock" in f)) return { pdt, mode };
  const edge = typeof f.edgeWallclock === "string" ? Date.parse(f.edgeWallclock) : Number.NaN;
  return { pdt, mode, edge: Number.isFinite(edge) ? edge : null };
}

export interface EdgeSummary {
  /** Live frames, and how many of them carried a usable edge. */
  live: number;
  withEdge: number;
  /** Live frames whose edge was behind their own playhead (an edge is never behind the playhead). */
  behindPlayhead: number;
  /** DVR frames that still carried an edge (they must send null). */
  dvrWithEdge: number;
  /** Median distance from the playhead to the reported edge (ms), null without edges. */
  medianLatencyMs: number | null;
}

/** What one member's frames say about its edge reports (batch 8, `edgeWallclock`). */
export function edgeSummary(samples: readonly PlayheadSample[]): EdgeSummary {
  let live = 0;
  let withEdge = 0;
  let behindPlayhead = 0;
  let dvrWithEdge = 0;
  const latencies: number[] = [];
  for (const s of samples) {
    const edge = s.edge ?? null;
    if (s.mode === "dvr") {
      if (edge !== null) dvrWithEdge++;
      continue;
    }
    live++;
    if (edge === null) continue;
    withEdge++;
    if (edge < s.pdt) behindPlayhead++;
    latencies.push(edge - s.pdt);
  }
  latencies.sort((a, b) => a - b);
  const medianLatencyMs = latencies.length === 0 ? null : Math.round(latencies[Math.floor(latencies.length / 2)]!);
  return { live, withEdge, behindPlayhead, dvrWithEdge, medianLatencyMs };
}

/**
 * How far each live member's playhead is behind the room's edge at `at` (ms): `max` of the
 * members' reported edges (extrapolated like the playheads) minus the member's playhead. Chat caps
 * it at `ROOM_LIMITS.edgeCapSeconds`; null when no member has a recent edge.
 */
export function behindRoomEdgeAt(
  samples: Readonly<Record<string, readonly PlayheadSample[]>>,
  at: number,
  maxAgeMs = 4_500,
): Record<string, number> | null {
  let edge: number | null = null;
  const heads: Record<string, number> = {};
  for (const [member, list] of Object.entries(samples)) {
    let latest: PlayheadSample | undefined;
    for (const s of list) if (s.sentAt <= at && (!latest || s.sentAt > latest.sentAt)) latest = s;
    if (!latest || latest.mode !== "live" || at - latest.sentAt > maxAgeMs) continue;
    const age = at - latest.sentAt;
    heads[member] = latest.pdt + age;
    if (latest.edge !== undefined && latest.edge !== null)
      edge = edge === null ? latest.edge + age : Math.max(edge, latest.edge + age);
  }
  if (edge === null) return null;
  const out: Record<string, number> = {};
  for (const [member, head] of Object.entries(heads)) out[member] = Math.round(edge - head);
  return out;
}

/** Each live member's playhead at `at`, from its latest sample no older than `maxAgeMs`. */
export function playheadsAt(
  samples: Readonly<Record<string, readonly PlayheadSample[]>>,
  at: number,
  maxAgeMs = 4_500,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [member, list] of Object.entries(samples)) {
    let latest: PlayheadSample | undefined;
    for (const s of list) if (s.sentAt <= at && (!latest || s.sentAt > latest.sentAt)) latest = s;
    if (!latest || latest.mode !== "live" || at - latest.sentAt > maxAgeMs) continue;
    out[member] = latest.pdt + (at - latest.sentAt);
  }
  return out;
}

/** The spread (ms) of the members' playheads at `at`, or null unless every member is known. */
export function deltaAt(
  samples: Readonly<Record<string, readonly PlayheadSample[]>>,
  at: number,
  members: readonly string[],
  maxAgeMs?: number,
): number | null {
  const heads = playheadsAt(samples, at, maxAgeMs);
  const values = members.map((m) => heads[m]);
  if (values.some((v) => v === undefined)) return null;
  const known = values as number[];
  return Math.max(...known) - Math.min(...known);
}

export interface DeltaSummary {
  /** Median spread over the instants with every member known, null when none. */
  medianMs: number | null;
  /**
   * 90th percentile (nearest rank) of the spread: what steps 1 and 2 assert, so a seek-only
   * sawtooth's peaks count. With the default 8 instants it is the largest one.
   */
  p90Ms: number | null;
  maxMs: number | null;
  /** Instants measured and instants with a member missing. */
  measured: number;
  missing: number;
}

/** The spread at `count` instants `stepMs` apart, ending at `end`. */
export function summarizeDelta(
  samples: Readonly<Record<string, readonly PlayheadSample[]>>,
  members: readonly string[],
  end: number,
  opts: { count?: number; stepMs?: number; maxAgeMs?: number } = {},
): DeltaSummary {
  const count = opts.count ?? 8;
  const stepMs = opts.stepMs ?? 1_000;
  const deltas: number[] = [];
  let missing = 0;
  for (let i = 0; i < count; i++) {
    const d = deltaAt(samples, end - i * stepMs, members, opts.maxAgeMs);
    if (d === null) missing++;
    else deltas.push(d);
  }
  if (deltas.length === 0) return { medianMs: null, p90Ms: null, maxMs: null, measured: 0, missing };
  const sorted = [...deltas].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p90 = sorted[Math.min(sorted.length, Math.ceil(sorted.length * 0.9)) - 1]!;
  return {
    medianMs: Math.round(median),
    p90Ms: Math.round(p90),
    maxMs: Math.round(sorted.at(-1)!),
    measured: deltas.length,
    missing,
  };
}

/** The `requirement` of a refused `watchRooms.*` call (an oRPC error), or null. */
export function refusalCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const r = (data as { requirement?: unknown }).requirement;
  return typeof r === "string" ? r : null;
}
