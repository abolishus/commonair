// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-content: the `vod_ready` inbox rows for seed-media's real recordings. Nothing is inserted
 * here: the media service writes one for the channel owner in the transaction that marks a VOD
 * ready (`services/media/src/vod/ready-notice.ts`), so every recorded VOD (streamer1's watch-page
 * VOD included) already has its row pointing at a real video. seed-media checks that it does, so a
 * stack that stopped writing them fails the seed instead of leaving the inbox without the type.
 * The table itself stays seed-platform's (it counts the rows; this unit only reads them).
 */
import type { DbHandle } from "@commonair/db";

export interface VodNotice {
  vodId: string;
  /** Rows of type `vod_ready` for the VOD's channel owner naming this VOD. */
  notices: number;
}

/** For each VOD, how many `vod_ready` rows its owner has for it. */
export async function vodReadyNotices(h: DbHandle, vodIds: readonly string[]): Promise<VodNotice[]> {
  if (vodIds.length === 0) return [];
  const rows = await h.sql<{ id: string; n: number }[]>`
    select v.id, (
      select count(*)::int from notifications n
      where n.user_id = c.owner_id and n.type = 'vod_ready' and n.payload->>'vodId' = v.id::text
    ) as n
    from vods v join channels c on c.id = v.channel_id
    where v.id = any(${[...vodIds]}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, Number(r.n)]));
  return vodIds.map((vodId) => ({ vodId, notices: byId.get(vodId) ?? 0 }));
}

/** The problems with a recording's notices, one line each (empty when every VOD has exactly one). Pure. */
export function vodNoticeProblems(rows: readonly VodNotice[]): string[] {
  return rows
    .filter((r) => r.notices !== 1)
    .map((r) =>
      r.notices === 0
        ? `VOD ${r.vodId} is ready but its owner has no vod_ready notification`
        : `VOD ${r.vodId} has ${r.notices} vod_ready notifications (want 1)`,
    );
}
