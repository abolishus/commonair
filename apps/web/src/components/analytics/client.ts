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

/** Share links one page lists (the newest; older ones stay revocable through the API). */
export const SHARE_LINK_PAGE = 100;

export function analyticsClient(): AnalyticsClient {
  return {
    range: (q) => api().analytics.range(q),
    broadcast: (q) => api().analytics.broadcast(q),
    shareLinks: (q) => api().analytics.shareLink.list({ channel: q.channel, limit: SHARE_LINK_PAGE }),
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
