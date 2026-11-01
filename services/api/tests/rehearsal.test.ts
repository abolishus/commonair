// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The rehearsal state machine and invitee rules (W2-rehearsal), without a database. */
import { describe, expect, test } from "vite-plus/test";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import { PLAYBACK_TOKEN_TTL_SECONDS } from "@commonair/contracts/tokens";
import type { RehearsalReport } from "@commonair/contracts/dto";
import {
  armRefusal,
  armRehearsal,
  capEndsAt,
  disarmRehearsal,
  inviteDecision,
  inviteToRehearsal,
  redactForSafety,
  rehearsalReport,
  rehearsalStatus,
  stateOf,
  watchExpiry,
  type InviteeFacts,
  type RehearsalActor,
} from "../src/stream/rehearsal.ts";

const idle = { suspended: false, live: false, rehearsing: false, armed: false };

describe("arm state machine", () => {
  test("arms only when idle; the most fundamental refusal wins", () => {
    expect(armRefusal(idle)).toBeNull();
    expect(armRefusal({ ...idle, armed: true })).toBe("armed");
    expect(armRefusal({ ...idle, rehearsing: true, armed: true })).toBe("rehearsing");
    expect(armRefusal({ ...idle, live: true, armed: true })).toBe("live");
    expect(armRefusal({ suspended: true, live: true, rehearsing: true, armed: true })).toBe("suspended");
  });

  test("state: rehearsing over armed over idle (a lapsed TTL is idle again)", () => {
    expect(stateOf({ rehearsing: false, armed: false })).toBe("idle");
    expect(stateOf({ rehearsing: false, armed: true })).toBe("armed");
    expect(stateOf({ rehearsing: true, armed: true })).toBe("rehearsing");
    expect(stateOf({ rehearsing: true, armed: false })).toBe("rehearsing");
  });

  test("the cap ends a rehearsal 30 minutes after it started", () => {
    const start = new Date("2026-11-01T12:00:00Z");
    expect(capEndsAt(start).toISOString()).toBe("2026-11-01T12:30:00.000Z");
  });

  test("a watch token lives the normal lifetime but never past the cap", () => {
    const start = new Date("2026-11-01T12:00:00Z");
    const startS = start.getTime() / 1000;
    expect(watchExpiry(startS, start)).toBe(startS + PLAYBACK_TOKEN_TTL_SECONDS);
    const late = startS + REHEARSAL_RULES.maxDurationSeconds - 30;
    expect(watchExpiry(late, start)).toBe(startS + REHEARSAL_RULES.maxDurationSeconds);
    expect(watchExpiry(startS + REHEARSAL_RULES.maxDurationSeconds + 5, start)).toBeLessThan(
      startS + REHEARSAL_RULES.maxDurationSeconds + 5,
    );
  });
});

describe("invitee rules", () => {
  const ok: InviteeFacts = {
    exists: true,
    deleted: false,
    suspended: false,
    isOwner: false,
    follows: true,
    alreadyInvited: false,
    invitedCount: 0,
  };

  test("a follower is added; a re-add is a no-op even when the list is full", () => {
    expect(inviteDecision(ok)).toBe("ok");
    expect(inviteDecision({ ...ok, alreadyInvited: true, invitedCount: 5 })).toBe("noop");
  });

  test("the sixth is refused; the fifth is not", () => {
    expect(inviteDecision({ ...ok, invitedCount: REHEARSAL_RULES.maxInvitees - 1 })).toBe("ok");
    expect(inviteDecision({ ...ok, invitedCount: REHEARSAL_RULES.maxInvitees })).toBe("invitee_limit");
  });

  test("missing, deleted, suspended, the owner and non-followers (an excluded follow) all read the same", () => {
    for (const f of [
      { exists: false },
      { deleted: true },
      { suspended: true },
      { isOwner: true },
      { follows: false },
    ] satisfies Partial<InviteeFacts>[])
      expect(inviteDecision({ ...ok, ...f })).toBe("not_follower");
    // Ineligibility is checked before the limit, so a full list never tells who is eligible.
    expect(inviteDecision({ ...ok, follows: false, invitedCount: 5 })).toBe("not_follower");
  });
});

describe("report redaction", () => {
  const report: RehearsalReport = {
    broadcastId: "0197f0aa-0000-7000-8000-000000000001",
    startedAt: "2026-11-01T12:00:00.000Z",
    endedAt: "2026-11-01T12:05:00.000Z",
    endReason: "cap",
    chat: {
      accepted: 3,
      held: { wordFilter: 1, link: 0, duplicate: 0, rateLimit: 0, other: 0 },
      rejected: { wordFilter: 0, link: 2, duplicate: 0, rateLimit: 0, other: 0 },
    },
    ingest: [{ check: "bitrate", ok: true, dips: [] }],
    moderation: { samples: 4, flagged: true },
    inviteesWatched: [{ id: "0197f0aa-0000-7000-8000-000000000002", username: "fan" }],
    updatedAt: "2026-11-01T12:05:00.000Z",
  };

  test("only a safety end is redacted, to the end and nothing more", () => {
    expect(redactForSafety(report)).toBe(report);
    const s = redactForSafety({ ...report, endReason: "safety" });
    expect(s).toMatchObject({ endReason: "safety", endedAt: report.endedAt, ingest: [], inviteesWatched: [] });
    expect(s.chat.accepted).toBe(0);
    expect(s.moderation).toEqual({ samples: 0, flagged: false });
  });
});

describe("app tokens are refused", () => {
  // Refused before anything is read, so no dependencies are needed.
  const actor = { deps: {}, channel: {}, userId: "u", session: false } as unknown as RehearsalActor;
  test.each([
    ["arm", () => armRehearsal(actor)],
    ["disarm", () => disarmRehearsal(actor)],
    ["status", () => rehearsalStatus(actor)],
    ["invite", () => inviteToRehearsal(actor, { username: "x", remove: false })],
    ["report", () => rehearsalReport(actor, undefined)],
  ])("%s", async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
