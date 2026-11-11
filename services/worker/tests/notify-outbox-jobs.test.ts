// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The outbox relay's notification hook (N1, ADR 0028 decision 8). */
import type { BusEvent } from "@commonair/contracts/events";
import { GoLiveJob, GovernanceEmailJob, NOTIFY_JOBS } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { notifyJobsFor } from "../src/notify/outbox-jobs.ts";

const CH = "0190f0f0-0000-7000-8000-00000000bbbb";
const ev = (id: string, type: string): BusEvent =>
  ({ id, type, version: "1", channelId: CH, payload: {}, occurredAt: "2026-10-30T00:00:00Z" }) as unknown as BusEvent;

describe("notifyJobsFor", () => {
  test("only stream.online starts a go-live fan-out, keyed by the event id", () => {
    const a = "0190f0f0-0000-7000-8000-000000000001";
    const b = "0190f0f0-0000-7000-8000-000000000002";
    const jobs = notifyJobsFor([
      ev(a, "stream.online"),
      ev("0190f0f0-0000-7000-8000-000000000003", "stream.offline"),
      ev("0190f0f0-0000-7000-8000-000000000004", "channel.follow"),
      ev(b, "stream.online"),
    ]);
    expect(jobs).toEqual([
      { name: NOTIFY_JOBS.goLive, data: { eventId: a, after: null }, opts: { jobId: `go-live-${a}` } },
      { name: NOTIFY_JOBS.goLive, data: { eventId: b, after: null }, opts: { jobId: `go-live-${b}` } },
    ]);
    // BullMQ job ids may not contain ":".
    for (const j of jobs) {
      expect(j.opts.jobId).not.toContain(":");
      expect(GoLiveJob.parse(j.data)).toEqual(j.data);
    }
  });

  test("a vote opening or a published result starts the governance mailer (wave 5); other statuses do not", () => {
    const p = "0190f0f0-0000-7000-8000-00000000cccc";
    const update = (id: string, status: string): BusEvent =>
      ({
        id,
        type: "coop.proposal.update",
        version: "1",
        channelId: null,
        payload: { proposal_id: p, title: "T", status, kind: "ordinary", passed: null, reason: null },
        occurredAt: "2026-11-11T00:00:00Z",
      }) as unknown as BusEvent;
    const ids = ["voting", "passed", "rejected", "council_review", "applied", "discussion"].map(
      (status, i) => [status, `0190f0f0-0000-7000-8000-00000000010${i}`] as const,
    );
    const jobs = notifyJobsFor(ids.map(([status, id]) => update(id, status)));
    expect(jobs).toEqual(
      ids.slice(0, 3).map(([, id]) => ({
        name: NOTIFY_JOBS.governanceEmail,
        data: { eventId: id, after: null },
        opts: { jobId: `governance-email-${id}` },
      })),
    );
    for (const j of jobs) {
      expect(j.opts.jobId).not.toContain(":");
      expect(GovernanceEmailJob.parse(j.data)).toEqual(j.data);
    }
    // A malformed payload is ignored rather than enqueued.
    const broken = { ...update("0190f0f0-0000-7000-8000-000000000200", "voting"), payload: { status: "voting" } };
    expect(notifyJobsFor([broken as unknown as BusEvent])).toEqual([]);
  });

  test("nothing to enqueue for an empty or unrelated batch", () => {
    expect(notifyJobsFor([])).toEqual([]);
    expect(notifyJobsFor([ev("0190f0f0-0000-7000-8000-000000000005", "stream.offline")])).toEqual([]);
  });
});
