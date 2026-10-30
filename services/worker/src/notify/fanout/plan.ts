// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Job ids and follow-up jobs of the go-live fan-out (contract step §1.6). BullMQ ids may not hold
 * `:`; each id is deterministic, so a second enqueue of the same job is a no-op.
 */
import { type DiscordJob, type GoLiveJob, NOTIFY_JOBS, type PushJob } from "@commonair/contracts/internal";

export const goLiveJobId = (eventId: string, after: string | null): string =>
  after === null ? `go-live-${eventId}` : `go-live-${eventId}-${after}`;
export const pushJobId = (eventId: string, userId: string): string => `push-${eventId}-${userId}`;
export const discordJobId = (eventId: string): string => `discord-${eventId}`;

interface Job<T> {
  name: string;
  data: T;
  opts: { jobId: string };
}

/**
 * The next page: only when this page came back full (`ids` in follower-id order). A short page is
 * the last one.
 */
export function nextPageJob(eventId: string, ids: readonly string[], pageSize: number): Job<GoLiveJob> | null {
  const last = ids.at(-1);
  if (ids.length < pageSize || last === undefined) return null;
  return { name: NOTIFY_JOBS.goLive, data: { eventId, after: last }, opts: { jobId: goLiveJobId(eventId, last) } };
}

export function pushJobs(
  ref: { eventId: string; channelId: string; broadcastId: string },
  userIds: readonly string[],
): Job<PushJob>[] {
  return userIds.map((userId) => ({
    name: NOTIFY_JOBS.push,
    data: { eventId: ref.eventId, userId, channelId: ref.channelId, broadcastId: ref.broadcastId },
    opts: { jobId: pushJobId(ref.eventId, userId) },
  }));
}

export function discordJob(ref: { eventId: string; channelId: string; broadcastId: string }): Job<DiscordJob> {
  return {
    name: NOTIFY_JOBS.discord,
    data: { channelId: ref.channelId, eventId: ref.eventId, broadcastId: ref.broadcastId, test: false },
    opts: { jobId: discordJobId(ref.eventId) },
  };
}
