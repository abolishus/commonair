// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Statements of reasons contract (ADR 0019 decisions 3, 4 and 8). */
import { describe, expect, test } from "vite-plus/test";
import { EnforcementFacts, EnforcementStatement } from "../src/api/entities.ts";
import { contract } from "../src/api/router.ts";
import {
  APPEAL_SUBJECTS,
  ENFORCEMENT_FACT_CODES,
  ENFORCEMENT_SOURCE_ACTIONS,
  LEGAL_DOCUMENT_KINDS,
} from "../src/enums.ts";

const ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
const AT = "2026-10-27T12:00:00.000Z";

const statement = {
  id: ID,
  sourceAuditId: ID,
  sourceAction: "moderation.t2.label",
  recipientUserId: ID,
  channelId: ID,
  content: { type: "channel", id: ID },
  restriction: { kind: "visibility", detail: "age_gated", endsAt: null, territorialScope: "all" },
  facts: { code: "classifier", category: "sexual", tier: "t2", threshold: 0.8, capturedAt: AT },
  source: "own_initiative",
  automatedDetection: true,
  automatedDecision: "fully",
  ground: { kind: "terms", clauseId: "mature.unlabelled", clauseVersion: 1, legalBasis: null },
  documents: { guidelinesId: ID, noticeId: ID },
  appeal: { kind: "moderation", subjectType: "content_label", subjectId: ID },
  createdAt: AT,
};

describe("enums", () => {
  test("the new legal kind and appeal subject are appended", () => {
    expect(LEGAL_DOCUMENT_KINDS.at(-1)).toBe("enforcement_notice");
    expect(APPEAL_SUBJECTS.at(-1)).toBe("ncii_request_item");
  });

  test("the source actions are ADR 0019 decision 3's allowlist", () => {
    expect([...ENFORCEMENT_SOURCE_ACTIONS].sort()).toEqual(
      [
        "moderation.t1.restrict",
        "moderation.t2.label",
        "moderation.t1.upload_reject",
        "moderation.case.warn",
        "moderation.case.end_stream",
        "moderation.case.suspend",
        "ncii.decide",
        "ncii.auto_hide",
        "moderation.t0.match",
      ].sort(),
    );
    // Never the non-restricting decisions.
    for (const a of ["moderation.t1.flag", "moderation.case.clear", "moderation.case.escalate_legal"])
      expect(ENFORCEMENT_SOURCE_ACTIONS).not.toContain(a);
  });

  test("the fact codes are exactly the facts union's discriminators", () => {
    const codes = EnforcementFacts.options.map((o) => o.shape.code.value);
    expect([...codes].sort()).toEqual([...ENFORCEMENT_FACT_CODES].sort());
  });
});

describe("EnforcementStatement", () => {
  test("accepts the decision 4 shape", () => {
    expect(EnforcementStatement.parse(statement)).toEqual(statement);
    expect(EnforcementStatement.safeParse({ ...statement, appeal: null }).success).toBe(true);
  });

  test("facts: no exact score, no free text, NCII-list hash matches only", () => {
    const ok = (facts: unknown) => EnforcementStatement.safeParse({ ...statement, facts }).success;
    expect(ok({ code: "hash_match", listCategory: "ncii", capturedAt: AT })).toBe(true);
    expect(ok({ code: "hash_match", listCategory: "csam", capturedAt: AT })).toBe(false);
    expect(ok({ code: "ncii_notice", requestId: ID, receivedAt: AT, deadlineAt: AT })).toBe(true);
    expect(ok({ code: "moderator_review", caseId: ID, caseOrigin: "classifier", decision: "warn" })).toBe(true);
    expect(ok({ code: "moderator_review", caseId: ID, caseOrigin: "hash_list", decision: "warn" })).toBe(false);
    expect(ok({ code: "moderator_review", caseId: ID, caseOrigin: "human", decision: "free text" })).toBe(false);
    expect(ok({ ...statement.facts, threshold: 1.5 })).toBe(false);
    expect(ok({ code: "other" })).toBe(false);
  });

  test("territorial scope is always all; the appeal kind is always moderation", () => {
    const bad = [
      { ...statement, restriction: { ...statement.restriction, territorialScope: "eu" } },
      { ...statement, appeal: { ...statement.appeal, kind: "dmca" } },
      { ...statement, sourceAction: "chat.ban" },
      { ...statement, ground: { ...statement.ground, clauseVersion: 0 } },
    ];
    for (const b of bad) expect(EnforcementStatement.safeParse(b).success).toBe(false);
  });
});

describe("me.enforcement.list", () => {
  test("a user GET at /me/enforcement, not a suspended-write exception", () => {
    const proc = contract.me.enforcement.list;
    const def = proc["~orpc"];
    expect(def.route.method).toBe("GET");
    expect(def.route.path).toBe("/me/enforcement");
    expect(def.meta.access).toBe("user");
    expect(def.meta.whileSuspended).toBeUndefined();
  });
});
