// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Overhaul wave 5 (w5-notify): the governance mailer's job, paging and rules, without a database. */
import { GovernanceEmailJob, NOTIFY_JOBS, QUEUES } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { JOBS } from "../src/jobs/index.ts";
import { job } from "../src/jobs/notify-governance-email.ts";
import {
  governanceEmailClaimKey,
  governanceEmailJobId,
  governanceEmailKind,
  nextGovernancePage,
  startsGovernanceEmail,
  turnoutOf,
} from "../src/notify/governance-email/send.ts";
import { buildRegistry } from "../src/runtime/registry.ts";

const E = "0190f0f0-0000-7000-8000-00000000eeee";
const U = (n: number) => `0190f0f0-0000-7000-8000-${String(n).padStart(12, "0")}`;

describe("the governance email job", () => {
  test("is registered on the notifications queue under the contract name, retried, not scheduled", () => {
    expect(JOBS).toContain(job);
    expect(buildRegistry(JOBS).get(QUEUES.notifications)?.get(NOTIFY_JOBS.governanceEmail)).toBe(job);
    expect(job.attempts).toBe(5);
    expect(job.schedule).toBeUndefined();
    expect(job.data).toBe(GovernanceEmailJob);
    expect(GovernanceEmailJob.parse({ eventId: E })).toEqual({ eventId: E, after: null });
  });
});

describe("rules", () => {
  test("voting opens a vote mail; a decision a result mail; nothing else mails", () => {
    expect(governanceEmailKind("voting")).toBe("vote_opened");
    expect(governanceEmailKind("passed")).toBe("result");
    expect(governanceEmailKind("rejected")).toBe("result");
    for (const s of ["draft", "discussion", "council_review", "applied", "withdrawn", ""])
      expect(governanceEmailKind(s)).toBeNull();
  });

  test("only well-formed coop.proposal.update events start a mailing", () => {
    const payload = { proposal_id: U(1), status: "voting" };
    expect(startsGovernanceEmail({ type: "coop.proposal.update", payload })).toBe(true);
    expect(startsGovernanceEmail({ type: "coop.membership.update", payload })).toBe(false);
    expect(startsGovernanceEmail({ type: "coop.proposal.update", payload: { status: "voting" } })).toBe(false);
    expect(startsGovernanceEmail({ type: "coop.proposal.update", payload: { ...payload, status: "applied" } })).toBe(
      false,
    );
  });

  test("job ids and claim keys are deterministic; job ids never hold ':'", () => {
    expect(governanceEmailJobId(E, null)).toBe(`governance-email-${E}`);
    expect(governanceEmailJobId(E, U(2))).toBe(`governance-email-${E}-${U(2)}`);
    expect(governanceEmailJobId(E, U(2))).not.toContain(":");
    expect(governanceEmailClaimKey(E, U(3))).toBe(`notify:governance-email:${E}:${U(3)}`);
  });

  test("the next page follows a full page only", () => {
    expect(nextGovernancePage(E, [U(1), U(2)], 2)).toEqual({
      name: NOTIFY_JOBS.governanceEmail,
      data: { eventId: E, after: U(2) },
      opts: { jobId: `governance-email-${E}-${U(2)}` },
    });
    expect(nextGovernancePage(E, [U(1)], 2)).toBeNull();
    expect(nextGovernancePage(E, [], 2)).toBeNull();
  });

  test("turnout counts every ballot, abstentions too, and is 0 with nobody eligible", () => {
    expect(turnoutOf({ eligible: 10, yes: 3, no: 1, abstain: 1 })).toBe(0.5);
    expect(turnoutOf({ eligible: 0, yes: 0, no: 0, abstain: 0 })).toBe(0);
    expect(turnoutOf({ eligible: 2, yes: 2, no: 1, abstain: 0 })).toBe(1);
  });
});
