// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The room sync target (decision (r)): the slowest live member's playhead, but never more than
 * `ROOM_LIMITS.edgeCapSeconds` behind the live edge. Pure, so it is unit-tested exhaustively.
 *
 * Each report is a member's playhead as a wall-clock instant (`playheadWallclock()`, the PDT under
 * the playhead) and when it was reported. A playing member's playhead advances with real time, so
 * a report is extrapolated to `now` before comparing. The edge is not known to chat; the most
 * advanced live member is its best proxy (every member's player sits at or behind the edge).
 * DVR-mode members and stale reports are left out: a DVR member rejoins live before it syncs.
 */
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import type { RoomSyncReport } from "@commonair/contracts/internal";

/** A report older than this is ignored (the member's tab is hidden, frozen or gone). */
export const SYNC_STALE_MS = 10_000;
/** How often an instance sends `room.sync` to its members. */
export const SYNC_TICK_MS = 2_000;

export interface SyncInput {
  reports: readonly RoomSyncReport[];
  now: number;
  edgeCapMs?: number;
  staleMs?: number;
}

/** The target playhead (epoch ms at `now`), or null when no live member reported recently. */
export function syncTarget({
  reports,
  now,
  edgeCapMs = ROOM_LIMITS.edgeCapSeconds * 1000,
  staleMs = SYNC_STALE_MS,
}: SyncInput): number | null {
  const heads: number[] = [];
  for (const r of reports) {
    if (r.mode !== "live") continue;
    const age = now - r.at;
    if (age < 0 || age > staleMs) continue;
    const head = Date.parse(r.playheadWallclock);
    if (!Number.isFinite(head)) continue;
    heads.push(head + age);
  }
  if (heads.length === 0) return null;
  const slowest = Math.min(...heads);
  const edge = Math.max(...heads);
  return Math.max(slowest, edge - edgeCapMs);
}

/** Parse a `KEYS.roomSync` hash (field → JSON), dropping malformed values. */
export function parseSyncHash(
  hash: Record<string, string>,
  parse: (raw: unknown) => RoomSyncReport | null,
): RoomSyncReport[] {
  const out: RoomSyncReport[] = [];
  for (const raw of Object.values(hash)) {
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
