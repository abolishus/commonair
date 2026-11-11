// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Public viewer counts: sessions with a heartbeat in the last 30 s whose verdict is
 * `verified`. Pending and excluded sessions never count. Cached 5 s in Valkey.
 */
import { and, eq, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";

export const VIEWER_STALE_MS = 30_000;
export const VIEWER_COUNT_TTL_SECONDS = 5;

const { playbackSessions, channels } = schema;

/**
 * The channel owner's own sessions (studio preview, their channel page) are not viewers (ADR 0014
 * amendment 2026-11-11). Signed-out sessions have no user id and still count.
 */
const notOwnSession = sql`${playbackSessions.userId} is distinct from (select ${channels.ownerId} from ${channels} where ${channels.id} = ${playbackSessions.channelId})`;

/**
 * The public live filter: open sessions on these channels, watching live (DVR viewers are catching
 * up, ADR 0016 decision 6; worker counters.ts), not the owner's own, with a heartbeat since `since`. The public count and
 * the dashboard's health card both read through it, so they cannot disagree (overhaul decision 2).
 */
export function liveSessionsWhere(channelIds: readonly string[], since: Date): SQL | undefined {
  return and(
    inArray(playbackSessions.channelId, [...channelIds]),
    notOwnSession,
    isNull(playbackSessions.endedAt),
    eq(playbackSessions.playbackMode, "live"),
    gt(playbackSessions.lastHeartbeatAt, since),
  );
}

export async function viewerCounts(deps: Deps, channelIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return out;
  const cached = await deps.valkey.mget(...ids.map((id) => KEYS.viewerCount(id)));
  const misses: string[] = [];
  ids.forEach((id, i) => {
    const v = cached[i];
    if (v !== null && v !== undefined && /^\d+$/.test(v)) out.set(id, Number(v));
    else misses.push(id);
  });
  if (misses.length === 0) return out;
  const since = new Date(deps.now().getTime() - VIEWER_STALE_MS);
  const rows = await deps.db
    .select({ channelId: playbackSessions.channelId, n: sql<number>`count(*)::int` })
    .from(playbackSessions)
    .where(and(liveSessionsWhere(misses, since), eq(playbackSessions.verdict, "verified")))
    .groupBy(playbackSessions.channelId);
  const counted = new Map(rows.map((r) => [r.channelId, Number(r.n)]));
  const pipe = deps.valkey.pipeline();
  for (const id of misses) {
    const n = counted.get(id) ?? 0;
    out.set(id, n);
    pipe.set(KEYS.viewerCount(id), String(n), "EX", VIEWER_COUNT_TTL_SECONDS);
  }
  await pipe.exec();
  return out;
}

/**
 * Verified viewers catching up in DVR mode (ADR 0016 decision 6), beside the live count. The worker's
 * counters publish `KEYS.catchingUpCount`; an absent or unreadable key is 0 (no DVR viewers, or the
 * counter has not run yet). A failed read is 0 too: the live count never depends on it.
 */
export async function catchingUpCounts(deps: Deps, channelIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(channelIds)];
  if (ids.length === 0) return out;
  const cached = await deps.valkey.mget(...ids.map((id) => KEYS.catchingUpCount(id))).catch(() => []);
  ids.forEach((id, i) => {
    const v = cached[i];
    out.set(id, v !== null && v !== undefined && /^\d+$/.test(v) ? Number(v) : 0);
  });
  return out;
}

export async function viewerCount(deps: Deps, channelId: string): Promise<number> {
  return (await viewerCounts(deps, [channelId])).get(channelId) ?? 0;
}

/**
 * The dashboard's health numbers (overhaul decision 2): `verified` is `viewerCount()`, the worker's
 * count that the public `<ViewerCount>` shows; `pending` and `excluded` use the same live filter;
 * `catchingUp` is the public DVR count beside it.
 */
export async function viewerBreakdown(deps: Deps, channelId: string) {
  const since = new Date(deps.now().getTime() - VIEWER_STALE_MS);
  const [verified, catchingUp, rows] = await Promise.all([
    viewerCount(deps, channelId),
    catchingUpCounts(deps, [channelId]),
    deps.db
      .select({ verdict: playbackSessions.verdict, n: sql<number>`count(*)::int` })
      .from(playbackSessions)
      .where(and(liveSessionsWhere([channelId], since), ne(playbackSessions.verdict, "verified")))
      .groupBy(playbackSessions.verdict),
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.verdict, Number(r.n)]));
  return {
    verified,
    pending: by.pending ?? 0,
    excluded: by.excluded ?? 0,
    catchingUp: catchingUp.get(channelId) ?? 0,
  };
}
