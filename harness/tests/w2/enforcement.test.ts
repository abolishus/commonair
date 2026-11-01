// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `enforcement` extension's planning (src/w2/enforcement.ts): top-ups to k − 1 and the below-k cell. */
import { readFileSync } from "node:fs";
import { ENFORCEMENT_SOURCE_ACTIONS } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import {
  ENFORCEMENT_IDS,
  SMALL_CANDIDATES,
  T1_CELL,
  T2_CELL,
  TIER_SOURCES,
  pickSmall,
  resolveStatementProblems,
  SOR_RESOLVE_CLAUSE,
  type StatementOf,
  refOf,
  rowOf,
  topUpPlan,
  value,
} from "../../src/w2/enforcement.ts";

describe("topUpPlan", () => {
  test("a fresh stack: seed k − 1 actions, k − 1 of them overturned when asked", () => {
    expect(topUpPlan({ count: 0, fully: 0, overturned: 0 }, { overturned: true })).toEqual({ seed: 9, overturned: 9 });
    expect(topUpPlan({ count: 0, fully: 0, overturned: 0 }, { overturned: false })).toEqual({ seed: 9, overturned: 0 });
  });
  test("a cell part of the way there gets only the rest", () => {
    expect(topUpPlan({ count: 4, fully: 4, overturned: 1 }, { overturned: true })).toEqual({ seed: 8, overturned: 8 });
    expect(topUpPlan({ count: 7, fully: 7, overturned: 0 }, { overturned: false })).toEqual({ seed: 2, overturned: 0 });
  });
  test("a cell already at or past k − 1 gets nothing", () => {
    expect(topUpPlan({ count: 9, fully: 9, overturned: 9 }, { overturned: true })).toEqual({ seed: 0, overturned: 0 });
    expect(topUpPlan({ count: 50, fully: 50, overturned: 20 }, { overturned: true })).toEqual({
      seed: 0,
      overturned: 0,
    });
  });
  test("more overturned rows needed than actions: the overturned rows are the seed", () => {
    expect(topUpPlan({ count: 30, fully: 30, overturned: 2 }, { overturned: true })).toEqual({
      seed: 7,
      overturned: 7,
    });
  });
});

describe("pickSmall", () => {
  test("the first candidate one row keeps under k", () => {
    expect(pickSmall([0, 0])).toBe(0);
    expect(pickSmall([9, 8, 0])).toBe(1);
    expect(pickSmall([9, 12, 40])).toBeNull();
    expect(pickSmall([])).toBeNull();
  });
});

describe("cells", () => {
  test("the followed and candidate cells are well-formed rule refs, distinct from each other", () => {
    const all = [T2_CELL, T1_CELL, ...SMALL_CANDIDATES];
    for (const c of all) {
      expect(refOf(c)).toMatch(/^[a-z][a-z0-9.-]*@1$/);
      expect(TIER_SOURCES[c.tier]).toContain(c.sourceAction);
    }
    expect(new Set(all.map((c) => `${refOf(c)}|${c.tier}`)).size).toBe(all.length);
  });

  test("tier sources are source actions, each in one tier (NCII decisions have none)", () => {
    const listed = Object.values(TIER_SOURCES).flat();
    expect(new Set(listed).size).toBe(listed.length);
    for (const a of listed) expect(ENFORCEMENT_SOURCE_ACTIONS).toContain(a);
    expect(listed).not.toContain("ncii.decide");
  });

  test("rowOf and value read the report", () => {
    const row = {
      ruleRef: "mature.unlabelled@1",
      tier: "t2" as const,
      count: { suppressed: false as const, value: 12 },
    };
    const report = { rows: [row, { ...row, tier: "t1" as const }] } as unknown as Parameters<typeof rowOf>[0];
    expect(rowOf(report, T2_CELL)).toBe(row);
    expect(value(row.count)).toBe(12);
    expect(value({ suppressed: true })).toBeNull();
    expect(value(undefined)).toBeNull();
  });

  test("the test ids it selects by are in docs/testing/w2-selectors.md", () => {
    const doc = readFileSync(new URL("../../../docs/testing/w2-selectors.md", import.meta.url), "utf8");
    for (const id of Object.values(ENFORCEMENT_IDS)) expect(doc).toContain(`\`${id}\``);
  });
});

describe("sor-resolve: the statement of a report resolved with a suspension", () => {
  const target = "01900000-0000-7000-8000-0000000000a1";
  const modActionId = "01900000-0000-7000-8000-0000000000a2";
  const at = Date.parse("2026-11-01T12:00:00.000Z");
  const want = { targetId: target, modActionId, clauseId: SOR_RESOLVE_CLAUSE, endsAtMs: at + 3_600_000 };
  const good: StatementOf = {
    recipientUserId: target,
    source: "notice_art16",
    restrictionKind: "account",
    restrictionDetail: "suspended",
    restrictionEndsAt: "2026-11-01T13:00:00.500Z",
    clauseId: SOR_RESOLVE_CLAUSE,
    appealSubjectType: "moderation_action",
    appealSubjectId: modActionId,
    factsCode: "moderator_review",
  };

  test("a matching statement has no problems (the end within clock skew)", () => {
    expect(resolveStatementProblems(good, want)).toEqual([]);
  });

  test("each difference is named", () => {
    expect(
      resolveStatementProblems(
        {
          ...good,
          recipientUserId: modActionId,
          source: "own_initiative",
          restrictionKind: "service",
          restrictionEndsAt: null,
          clauseId: "guidelines.general",
          appealSubjectType: "moderation_case",
          factsCode: "classifier",
        },
        want,
      ),
    ).toEqual([
      "recipient",
      "source own_initiative",
      "restriction service/suspended",
      "ends null",
      "clause guidelines.general",
      `appeal moderation_case/${modActionId}`,
      "facts classifier",
    ]);
    expect(resolveStatementProblems({ ...good, restrictionEndsAt: "2026-11-01T14:00:00.000Z" }, want)).toEqual([
      "ends 2026-11-01T14:00:00.000Z",
    ]);
  });
});
