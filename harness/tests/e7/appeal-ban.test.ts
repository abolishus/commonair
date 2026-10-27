// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `trust-safety` step 9's pure helpers. */
import { describe, expect, test } from "vite-plus/test";
import {
  type AuditEntry,
  type ModActionView,
  appealBody,
  findAppealUnban,
  findBanAction,
  isSuspendedRefusal,
  sendAccepted,
} from "../../src/e7/appeal-ban.ts";

const V = "0192f000-0000-7000-8000-000000000001";
const OTHER = "0192f000-0000-7000-8000-000000000002";
const MOD = "0192f000-0000-7000-8000-000000000003";
const APPEAL = "0192f000-0000-7000-8000-000000000004";

const action = (over: Partial<ModActionView>): ModActionView => ({
  id: "0192f000-0000-7000-8000-0000000000a0",
  scope: "channel",
  channelSlug: "h",
  moderator: { id: OTHER, username: "h" },
  target: { id: V, username: "v" },
  action: "ban",
  reason: "",
  durationSeconds: null,
  createdAt: "2026-10-27T10:00:00.000Z",
  ...over,
});

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: "0192f000-0000-7000-8000-0000000000b0",
  actorType: "moderator",
  actorId: MOD,
  action: "chat.unban",
  subjectType: "user",
  subjectId: V,
  reason: "",
  details: { banId: OTHER, appealId: APPEAL },
  createdAt: "2026-10-27T10:05:00.000Z",
  ...over,
});

describe("findBanAction", () => {
  test("the newest ban of the target, ignoring other actions and other targets", () => {
    const older = action({ id: "0192f000-0000-7000-8000-0000000000a1", createdAt: "2026-10-27T09:00:00.000Z" });
    const newer = action({ id: "0192f000-0000-7000-8000-0000000000a2" });
    const timeout = action({
      id: "0192f000-0000-7000-8000-0000000000a3",
      action: "timeout",
      createdAt: "2026-10-27T11:00:00.000Z",
    });
    const someoneElse = action({ id: "0192f000-0000-7000-8000-0000000000a4", target: { id: OTHER, username: "o" } });
    expect(findBanAction([older, timeout, newer, someoneElse], V)?.id).toBe(newer.id);
  });

  test("null when there is none (or the target was deleted)", () => {
    expect(findBanAction([], V)).toBeNull();
    expect(findBanAction([action({ target: null })], V)).toBeNull();
  });
});

describe("findAppealUnban", () => {
  test("only the moderator's chat.unban that names the appeal", () => {
    const right = entry({});
    const byStreamer = entry({ id: "0192f000-0000-7000-8000-0000000000b1", actorId: OTHER });
    const manual = entry({ id: "0192f000-0000-7000-8000-0000000000b2", details: { banId: OTHER } });
    const untimeout = entry({ id: "0192f000-0000-7000-8000-0000000000b3", action: "chat.untimeout" });
    expect(findAppealUnban([byStreamer, manual, untimeout, right], { moderatorId: MOD, appealId: APPEAL })?.id).toBe(
      right.id,
    );
    expect(findAppealUnban([byStreamer, manual, untimeout], { moderatorId: MOD, appealId: APPEAL })).toBeNull();
  });
});

describe("small helpers", () => {
  test("a send is accepted only with a message id", () => {
    expect(sendAccepted({ id: APPEAL, held: false })).toBe(true);
    expect(sendAccepted({ id: null, held: false })).toBe(false);
    expect(sendAccepted({ id: null, held: true })).toBe(false);
  });

  test("a suspended refusal is FORBIDDEN", () => {
    expect(isSuspendedRefusal({ code: "FORBIDDEN", status: 403 })).toBe(true);
    expect(isSuspendedRefusal({ code: "NOT_FOUND", status: 404 })).toBe(false);
    expect(isSuspendedRefusal(null)).toBe(false);
  });

  test("the appeal body is run-unique and within 10–5000 characters", () => {
    const body = appealBody("run-123", "chat ban");
    expect(body).toContain("run-123");
    expect(body.length).toBeGreaterThanOrEqual(10);
    expect(body.length).toBeLessThanOrEqual(5000);
    expect(body).not.toMatch(/@/);
  });
});
