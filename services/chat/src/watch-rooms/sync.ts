// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The room sync target (decision (r)): the slowest live member's playhead, but never more than
 * `ROOM_LIMITS.edgeCapSeconds` behind the live edge. Pure, so it is unit-tested exhaustively.
 *
 * Each report is a member's playhead as a wall-clock instant (`playheadWallclock()`, the PDT under
 * the playhead) and when it was reported. A playing member's playhead advances with real time, so
 * a report is extrapolated to `now` before comparing. DVR-mode members and stale reports are left
 * out: a DVR member rejoins live before it syncs.
 *
 * **The live edge** (batch 8, W3-watch-rooms review MEDIUM 1). Players since batch 8 report their
 * own live edge as a wall-clock instant (`edgeWallclock`; null in DVR). The edge is then
 * `max(edgeWallclock)` of the fresh live reports (the same staleness window as the playheads,
 * extrapolated the same way: reports arrive every 2 s, so a 2 s window would race the tick).
 * Members on different sources (a relay against the origin) have different latencies, but they
 * report wall-clock edges, not offsets, so the maximum is the most current one. The edge is never
 * below the most advanced playhead, so an older client on a faster source still counts.
 *
 * **A lying client must not drag the room forward.** A playhead or an edge more than
 * `EDGE_SKEW_MS` ahead of chat's clock is dropped: no live edge is in the future. The target is
 * never past the edge, so the room never goes past `now + EDGE_SKEW_MS`.
 *
 * **The fallback** (no fresh report carries an edge: older clients only, or every newer one in
 * DVR). The most advanced member is a proxy, but not on its own: that member then steers back to
 * the target, so the "edge" would move back with it and a slow member could drag the room any
 * distance behind live. So the edge estimate is remembered between ticks (`EdgeEstimate`, shared
 * in the sync hash) and extrapolated with real time; it never falls back with the members, and it
 * is bounded at `edgeCapMs + EDGE_SLACK_MS` ahead of the most advanced member, so a stalled stream
 * cannot push the target past what players can reach for long. A reported edge is remembered the
 * same way, so the fallback carries on from the last edge a newer client reported.
 */
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import type { RoomSyncReport } from "@commonair/contracts/internal";

/** A report older than this is ignored (the member's tab is hidden, frozen or gone). */
export const SYNC_STALE_MS = 10_000;
/** How often an instance sends `room.sync` to its members. */
export const SYNC_TICK_MS = 2_000;
/** How far the remembered edge may run ahead of the cap point of the most advanced member. */
export const EDGE_SLACK_MS = 2_000;
/** A remembered edge older than this is dropped (the room had no live reports for a while). */
export const EDGE_MEMORY_MS = 60_000;
/** The `KEYS.roomSync` field the shared edge estimate is kept in (never a user id). */
export const EDGE_FIELD = "_edge";
/**
 * How far ahead of chat's clock a reported playhead or edge may be before it is dropped. The PDT is
 * stamped by our origin's clock and chat runs on ours, so an honest report is behind `now` by the
 * stream's latency (seconds); this only absorbs clock skew between our own hosts.
 */
export const EDGE_SKEW_MS = 1_000;

/** The edge estimate (epoch ms of the live edge) as of `at`. */
export interface EdgeEstimate {
  edge: number;
  at: number;
}

export interface SyncInput {
  reports: readonly RoomSyncReport[];
  now: number;
  edgeCapMs?: number;
  staleMs?: number;
  /** The previous tick's estimate, from any instance. */
  prevEdge?: EdgeEstimate | null;
}

export interface SyncResult {
  /** The target playhead (epoch ms at `now`). */
  target: number;
  /** The edge estimate to remember for the next tick. */
  edge: EdgeEstimate;
}

/** The target playhead (epoch ms at `now`), or null when no live member reported recently. */
export function syncTarget(input: SyncInput): number | null {
  return syncState(input)?.target ?? null;
}

/** The target and the edge estimate to carry to the next tick, or null without live reports. */
export function syncState({
  reports,
  now,
  edgeCapMs = ROOM_LIMITS.edgeCapSeconds * 1000,
  staleMs = SYNC_STALE_MS,
  prevEdge = null,
}: SyncInput): SyncResult | null {
  const heads: number[] = [];
  const edges: number[] = [];
  const ceiling = now + EDGE_SKEW_MS;
  for (const r of reports) {
    if (r.mode !== "live") continue;
    const age = now - r.at;
    if (age < 0 || age > staleMs) continue;
    const head = Date.parse(r.playheadWallclock) + age;
    if (!Number.isFinite(head) || head > ceiling) continue;
    heads.push(head);
    if (r.edgeWallclock) {
      const edge = Date.parse(r.edgeWallclock) + age;
      if (Number.isFinite(edge) && edge <= ceiling) edges.push(edge);
    }
  }
  if (heads.length === 0) return null;
  const slowest = Math.min(...heads);
  const leader = Math.max(...heads);
  let edge = leader;
  if (edges.length > 0) {
    edge = Math.max(leader, ...edges);
  } else if (prevEdge && Number.isFinite(prevEdge.edge) && prevEdge.at <= now && now - prevEdge.at <= EDGE_MEMORY_MS) {
    const carried = prevEdge.edge + (now - prevEdge.at);
    edge = Math.max(leader, Math.min(carried, leader + edgeCapMs + EDGE_SLACK_MS, ceiling));
  }
  // `edge >= leader >= slowest`, so the target is never past the edge (nor past `ceiling`).
  return { target: Math.max(slowest, edge - edgeCapMs), edge: { edge, at: now } };
}

/** Parse the shared edge estimate field, or null. */
export function parseEdge(raw: string | undefined): EdgeEstimate | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const { edge, at } = v as Record<string, unknown>;
    return typeof edge === "number" && typeof at === "number" && Number.isFinite(edge) && Number.isFinite(at)
      ? { edge, at }
      : null;
  } catch {
    return null;
  }
}

/** Parse a `KEYS.roomSync` hash (field → JSON), dropping malformed values. */
export function parseSyncHash(
  hash: Record<string, string>,
  parse: (raw: unknown) => RoomSyncReport | null,
): RoomSyncReport[] {
  const out: RoomSyncReport[] = [];
  for (const [field, raw] of Object.entries(hash)) {
    if (field === EDGE_FIELD) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    const r = parse(json);
    if (r) out.push(r);
  }
  return out;
}
