// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d7-admin (README D7.5): the queue roles behind `admin.overview` and the claiming rules. */
import { describe, expect, test } from "vite-plus/test";
import { ADMIN_QUEUES } from "@commonair/contracts/enums";
import { planAssign } from "../src/admin-console/assign.ts";
import { queuesFor } from "../src/admin-console/overview.ts";

describe("queuesFor", () => {
  test("each role gets the queues its procedures allow", () => {
    expect(queuesFor("moderator")).toEqual(["moderation", "appeals", "dmca", "ncii"]);
    expect(queuesFor("legal")).toEqual(["legal", "ncii"]);
    expect(queuesFor("treasurer")).toEqual(["payments"]);
    expect(queuesFor("admin")).toEqual(ADMIN_QUEUES.filter((q) => q !== "legal"));
    expect(queuesFor("user")).toEqual([]);
  });

  test("T0 (the legal queue) is legal's alone", () => {
    for (const role of ["user", "moderator", "admin", "treasurer"] as const)
      expect(queuesFor(role)).not.toContain("legal");
  });
});

describe("planAssign", () => {
  const base = { callerId: "me", callerRole: "moderator", open: true };

  test("claiming a free open case, and repeating it, are fine; the repeat changes nothing", () => {
    expect(planAssign({ ...base, current: null, next: "me" })).toEqual({ ok: true, change: true });
    expect(planAssign({ ...base, current: "me", next: "me" })).toEqual({ ok: true, change: false });
    expect(planAssign({ ...base, current: null, next: null })).toEqual({ ok: true, change: false });
  });

  test("the holder releases; someone else's claim is a conflict unless an admin acts", () => {
    expect(planAssign({ ...base, current: "me", next: null })).toEqual({ ok: true, change: true });
    expect(planAssign({ ...base, current: "other", next: null })).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(planAssign({ ...base, current: "other", next: "me" })).toMatchObject({ ok: false, code: "CONFLICT" });
    expect(planAssign({ ...base, callerRole: "admin", current: "other", next: "me" })).toEqual({
      ok: true,
      change: true,
    });
  });

  test("assigning someone else needs an admin", () => {
    expect(planAssign({ ...base, current: null, next: "other" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(planAssign({ ...base, callerRole: "legal", current: null, next: "other" })).toMatchObject({ ok: false });
    expect(planAssign({ ...base, callerRole: "admin", current: null, next: "other" })).toEqual({
      ok: true,
      change: true,
    });
  });

  test("a decided case can be released, never claimed", () => {
    expect(planAssign({ ...base, open: false, current: null, next: "me" })).toMatchObject({ code: "CONFLICT" });
    expect(planAssign({ ...base, open: false, current: "me", next: null })).toEqual({ ok: true, change: true });
  });
});
