// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The outbox relay's notification hook (N1, ADR 0028 decision 8). N4 extends this one function. */
import type { BusEvent } from "@commonair/contracts/events";
import { NOTIFY_JOBS, type GoLiveJob } from "@commonair/contracts/internal";

/** Jobs the outbox relay enqueues for notifications (ADR 0028 decision 8), whether or not a webhook subscription exists. */
export function notifyJobsFor(
  events: readonly BusEvent[],
): { name: string; data: GoLiveJob; opts: { jobId: string } }[] {
  return events
    .filter((e) => e.type === "stream.online")
    .map((e) => ({
      name: NOTIFY_JOBS.goLive,
      data: { eventId: e.id, after: null },
      opts: { jobId: `go-live-${e.id}` },
    }));
}
