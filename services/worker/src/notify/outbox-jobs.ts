// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The outbox relay's notification hook (N1, ADR 0028 decision 8). N4 extends this one function. */
import type { BusEvent } from "@commonair/contracts/events";
import { NOTIFY_JOBS, type GoLiveJob, type GovernanceEmailJob } from "@commonair/contracts/internal";
import { governanceEmailJobId, startsGovernanceEmail } from "./governance-email/send.ts";

export interface NotifyOutboxJob {
  name: string;
  data: GoLiveJob | GovernanceEmailJob;
  opts: { jobId: string };
}

/**
 * Jobs the outbox relay enqueues for notifications (ADR 0028 decision 8), whether or not a webhook
 * subscription exists: the go-live fan-out per `stream.online`, and (overhaul wave 5) the
 * governance mailer per vote opening or published result.
 */
export function notifyJobsFor(events: readonly BusEvent[]): NotifyOutboxJob[] {
  return events.flatMap((e): NotifyOutboxJob[] => {
    if (e.type === "stream.online")
      return [{ name: NOTIFY_JOBS.goLive, data: { eventId: e.id, after: null }, opts: { jobId: `go-live-${e.id}` } }];
    if (startsGovernanceEmail(e))
      return [
        {
          name: NOTIFY_JOBS.governanceEmail,
          data: { eventId: e.id, after: null },
          opts: { jobId: governanceEmailJobId(e.id, null) },
        },
      ];
    return [];
  });
}
