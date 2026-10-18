// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Public viewer counts: sessions with a heartbeat in the last 30 s whose verdict is
 * `verified`. Pending and excluded sessions never count. Cached 5 s in Valkey.
 */
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { KEYS } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";

export const VIEWER_STALE_MS = 30_000;
export const VIEWER_COUNT_TTL_SECONDS = 5;

const { playbackSessions } = schema;

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
    .where(
      and(
        inArray(playbackSessions.channelId, misses),
        isNull(playbackSessions.endedAt),
        eq(playbackSessions.verdict, "verified"),
        gt(playbackSessions.lastHeartbeatAt, since),
      ),
    )
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

export async function viewerCount(deps: Deps, channelId: string): Promise<number> {
  return (await viewerCounts(deps, [channelId])).get(channelId) ?? 0;
}

/** Verified / pending / excluded among currently active sessions (dashboard health). */
export async function viewerBreakdown(deps: Deps, channelId: string) {
  const since = new Date(deps.now().getTime() - VIEWER_STALE_MS);
  const rows = await deps.db
    .select({ verdict: playbackSessions.verdict, n: sql<number>`count(*)::int` })
    .from(playbackSessions)
    .where(
      and(
        eq(playbackSessions.channelId, channelId),
        isNull(playbackSessions.endedAt),
        gt(playbackSessions.lastHeartbeatAt, since),
      ),
    )
    .groupBy(playbackSessions.verdict);
  const by = Object.fromEntries(rows.map((r) => [r.verdict, Number(r.n)]));
  return { verified: by.verified ?? 0, pending: by.pending ?? 0, excluded: by.excluded ?? 0 };
}
