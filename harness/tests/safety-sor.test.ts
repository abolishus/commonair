// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `trust-safety` step 11's pure helpers against docs/testing/w0-selectors.md "Statements of reasons". */
import { ENFORCEMENT_SOURCE_ACTIONS } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { expectedStatement, freshMagicLink, statementProblems, type StatementRow } from "../src/safety-sor.ts";

const row = (action: string, details: Record<string, unknown> = {}) => ({ id: "a", action, details });

describe("expectedStatement follows the selectors table", () => {
  test("restriction and appeal subject per source action", () => {
    expect(expectedStatement(row("moderation.t1.restrict", { category: "weapons" }))).toEqual({
      restrictions: ["visibility/restricted"],
      clauseIds: ["safety.weapons"],
      appealSubjectType: "moderation_case",
    });
    expect(expectedStatement(row("moderation.t2.label"))).toMatchObject({
      restrictions: ["visibility/age_gated"],
      clauseIds: ["mature.unlabelled"],
      appealSubjectType: "content_label",
    });
    expect(expectedStatement(row("moderation.t1.upload_reject", { category: "sexual" }))).toMatchObject({
      restrictions: ["visibility/removed"],
      clauseIds: ["safety.sexual-explicit"],
    });
    expect(expectedStatement(row("moderation.case.warn"))?.restrictions).toEqual(["warning/none"]);
    expect(expectedStatement(row("moderation.case.suspend"))?.restrictions).toEqual([
      "account/suspended",
      "service/suspended",
    ]);
    expect(expectedStatement(row("ncii.decide", { decision: "removed" }))).toMatchObject({
      restrictions: ["visibility/removed"],
      appealSubjectType: "ncii_request_item",
    });
    expect(expectedStatement(row("ncii.auto_hide"))?.restrictions).toEqual(["visibility/disabled"]);
    expect(expectedStatement(row("moderation.t0.match", { listCategory: "ncii" }))).toEqual({
      restrictions: ["account/suspended"],
      clauseIds: ["illegal.ncii"],
      appealSubjectType: null,
    });
  });

  test("no statement for a rejected NCII request, a CSAM-list match, or anything not allowlisted", () => {
    expect(expectedStatement(row("ncii.decide", { decision: "rejected" }))).toBeNull();
    expect(expectedStatement(row("moderation.t0.match", { listCategory: "csam" }))).toBeNull();
    expect(expectedStatement(row("moderation.case.end_stream", { streamEnded: false }))).toBeNull();
    expect(
      expectedStatement(row("moderation.case.suspend", { suspendTarget: "user", userSuspended: false })),
    ).toBeNull();
    expect(
      expectedStatement(row("moderation.case.suspend", { suspendTarget: "both", userSuspended: false }))?.restrictions,
    ).toEqual(["service/suspended"]);
    for (const a of ["moderation.t1.flag", "moderation.case.clear", "moderation.case.escalate_legal", "chat.ban"])
      expect(expectedStatement(row(a))).toBeNull();
  });

  test("every allowlisted action is covered", () => {
    for (const a of ENFORCEMENT_SOURCE_ACTIONS)
      expect(expectedStatement(row(a, { decision: "removed", listCategory: "ncii" })), a).not.toBeNull();
  });
});

describe("statementProblems", () => {
  const s: StatementRow = {
    id: "s",
    sourceAuditId: "a",
    sourceAction: "moderation.t1.restrict",
    recipientUserId: "u1",
    restrictionKind: "visibility",
    restrictionDetail: "restricted",
    clauseId: "safety.weapons",
    appealSubjectType: "moderation_case",
  };
  const e = expectedStatement(row("moderation.t1.restrict", { category: "weapons" }))!;

  test("a matching statement has none", () => {
    expect(statementProblems(s, e, new Set(["u1"]))).toEqual([]);
  });

  test("names each difference", () => {
    expect(
      statementProblems(
        { ...s, restrictionDetail: "removed", clauseId: "x", appealSubjectType: null, recipientUserId: "u2" },
        e,
        new Set(["u1"]),
      ),
    ).toEqual(["restriction visibility/removed", "clause x", "appeal none", "recipient outside the run"]);
  });
});

describe("freshMagicLink", () => {
  const since = Date.parse("2026-10-27T12:00:00Z");
  const mail = (created: string, subject: string, link: string) => ({ created, subject, text: link, html: "" });

  test("picks the newest sign-in mail sent after the request, never the old verification mail", () => {
    const messages = [
      mail(
        "2026-10-27T11:00:00Z",
        "Your sign-in link for Air",
        "https://air.test/api/auth/magic-link/verify?token=old",
      ),
      mail("2026-10-27T12:00:05Z", "Confirm your email address", "https://air.test/api/auth/verify-email?token=v"),
      mail(
        "2026-10-27T12:00:02Z",
        "Your sign-in link for Air",
        "https://air.test/api/auth/magic-link/verify?token=new",
      ),
    ];
    expect(freshMagicLink(messages, since)).toBe("https://air.test/api/auth/magic-link/verify?token=new");
  });

  test("null when nothing new arrived", () => {
    expect(freshMagicLink([], since)).toBeNull();
  });
});
