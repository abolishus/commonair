// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AnalyticsRange, AnalyticsShareLink, BroadcastAnalytics } from "@commonair/contracts/dto";
import { api, errorCode } from "../../lib/api.ts";

/** The `analytics.*` calls the studio page makes, injectable for render tests. */
export interface AnalyticsClient {
  range: (q: { channel: string; from: string; to: string }) => Promise<AnalyticsRange>;
  broadcast: (q: { channel: string; broadcastId: string }) => Promise<BroadcastAnalytics>;
  shareLinks: (q: { channel: string }) => Promise<{ items: AnalyticsShareLink[]; nextCursor: string | null }>;
  createShareLink: (q: { channel: string; broadcastId: string }) => Promise<AnalyticsShareLink>;
  revokeShareLink: (q: { channel: string; id: string }) => Promise<unknown>;
}

/** Share links one request lists (the contract's page maximum). */
export const SHARE_LINK_PAGE = 100;
/**
 * Pages the studio reads at most. The list is the whole channel's, newest first, and the page
 * filters it to one broadcast, so it pages through rather than stopping at the newest 100.
 */
export const SHARE_LINK_MAX_PAGES = 20;

/** Every page of a cursor-paged list, up to `maxPages`; `nextCursor` is non-null when it stopped early. */
export async function allPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages: number = SHARE_LINK_MAX_PAGES,
): Promise<{ items: T[]; nextCursor: string | null }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const p = await fetchPage(cursor);
    items.push(...p.items);
    if (p.nextCursor === null) return { items, nextCursor: null };
    cursor = p.nextCursor;
  }
  return { items, nextCursor: cursor ?? null };
}

export function analyticsClient(): AnalyticsClient {
  return {
    range: (q) => api().analytics.range(q),
    broadcast: (q) => api().analytics.broadcast(q),
    shareLinks: (q) =>
      allPages((cursor) => api().analytics.shareLink.list({ channel: q.channel, limit: SHARE_LINK_PAGE, cursor })),
    createShareLink: (q) => api().analytics.shareLink.create({ ...q, expiresInDays: 30 }),
    revokeShareLink: (q) => api().analytics.shareLink.revoke(q),
  };
}

/** PRECONDITION_FAILED `analytics_pending`: live, inside the 24 h display delay, or not rolled up yet. */
export function isPending(err: unknown): boolean {
  if (errorCode(err) !== "PRECONDITION_FAILED") return false;
  const data = (err as { data?: { requirement?: unknown } }).data;
  return data?.requirement === "analytics_pending";
}
