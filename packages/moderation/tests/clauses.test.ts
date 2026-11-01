// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The enforcement report's view of the clause catalog (batch 6 decision (d)): groups and `rule_ref`. */
import { MODERATION_CATEGORIES, REPORT_REASONS, RULE_REF_PATTERN } from "@commonair/contracts/enums";
import { EnforcementReportRow } from "@commonair/contracts/dto";
import { describe, expect, test } from "vite-plus/test";
import {
  CATEGORY_CLAUSES,
  CLAUSES,
  clauseFor,
  clauseRef,
  currentClause,
  groupOfClauseId,
  NCII_CLAUSE_ID,
  parseRuleRef,
  REPORT_GROUP_IDS,
  REPORT_GROUPS,
  REPORT_REASON_CLAUSES,
  ruleRefFor,
  T2_CLAUSE_ID,
  type ClauseInput,
} from "../src/clauses.ts";
import * as reasons from "../src/reasons.ts";

describe("REPORT_GROUPS", () => {
  test("every clause in the catalog has a group", () => {
    for (const c of CLAUSES) expect(REPORT_GROUPS[c.id], `${c.id} has no report group`).toBeDefined();
  });

  test("groups come from the id prefix; guidelines.* is general", () => {
    expect(REPORT_GROUPS["safety.weapons"]).toBe("safety");
    expect(REPORT_GROUPS["decency.hate"]).toBe("decency");
    expect(REPORT_GROUPS["honesty.spam"]).toBe("honesty");
    expect(REPORT_GROUPS["creative.copyright"]).toBe("creative");
    expect(REPORT_GROUPS["mature.unlabelled"]).toBe("mature");
    expect(REPORT_GROUPS["illegal.ncii"]).toBe("illegal");
    expect(REPORT_GROUPS["guidelines.general"]).toBe("general");
  });

  test("an unknown prefix has no group (and no inherited key leaks through)", () => {
    expect(groupOfClauseId("nope.thing")).toBeUndefined();
    expect(groupOfClauseId("constructor.x")).toBeUndefined();
    expect(groupOfClauseId("toString")).toBeUndefined();
    expect(groupOfClauseId("")).toBeUndefined();
  });

  test("the group ids are exactly the contract's enum, and every one is used", () => {
    expect([...REPORT_GROUP_IDS].sort()).toEqual([...EnforcementReportRow.shape.group.options].sort());
    const used = new Set(Object.values(REPORT_GROUPS));
    for (const g of REPORT_GROUP_IDS) expect(used.has(g), `${g} has no clause`).toBe(true);
  });

  test("clauses.ts declares no clause: the re-exports are the catalog's own objects", () => {
    expect(CLAUSES).toBe(reasons.CLAUSES);
    expect(clauseFor).toBe(reasons.clauseFor);
    expect(CATEGORY_CLAUSES).toBe(reasons.CATEGORY_CLAUSES);
  });
});

describe("ruleRefFor", () => {
  const current = (id: string) => clauseRef(currentClause(id)!);

  test("T1 restrict and upload reject cite the category's clause", () => {
    for (const category of MODERATION_CATEGORIES)
      for (const action of ["moderation.t1.restrict", "moderation.t1.upload_reject"] as const)
        expect(ruleRefFor({ action, category })).toBe(current(CATEGORY_CLAUSES[category]));
  });

  test("a T2 label cites the mature-label clause", () => {
    expect(ruleRefFor({ action: "moderation.t2.label" })).toBe(current(T2_CLAUSE_ID));
    expect(ruleRefFor({ action: "moderation.t2.label" })).toBe("mature.unlabelled@1");
  });

  test("case decisions: category first, then the report reason, then the general clause", () => {
    for (const action of ["moderation.case.warn", "moderation.case.end_stream", "moderation.case.suspend"] as const) {
      expect(ruleRefFor({ action, category: "weapons", reportReason: "spam" })).toBe("safety.weapons@1");
      for (const reason of REPORT_REASONS)
        expect(ruleRefFor({ action, category: null, reportReason: reason })).toBe(
          current(REPORT_REASON_CLAUSES[reason]),
        );
      expect(ruleRefFor({ action, category: null, reportReason: null })).toBe("guidelines.general@1");
    }
  });

  test("NCII decisions, auto-hides and NCII-list T0 matches cite the illegal ground", () => {
    const inputs: ClauseInput[] = [
      { action: "ncii.decide" },
      { action: "ncii.auto_hide" },
      { action: "moderation.t0.match", listCategory: "ncii" },
    ];
    for (const input of inputs) expect(ruleRefFor(input)).toBe(current(NCII_CLAUSE_ID));
  });

  test("every rule_ref ruleRefFor can produce passes the database pattern and parses back", () => {
    const re = new RegExp(RULE_REF_PATTERN);
    for (const c of CLAUSES) {
      const ref = clauseRef(c);
      expect(re.test(ref), ref).toBe(true);
      expect(parseRuleRef(ref)).toEqual({ id: c.id, version: c.version });
    }
  });
});

describe("parseRuleRef", () => {
  test("parses id and version", () => {
    expect(parseRuleRef("safety.self-harm@1")).toEqual({ id: "safety.self-harm", version: 1 });
    expect(parseRuleRef("a@12")).toEqual({ id: "a", version: 12 });
  });

  test.each([
    ["", "empty"],
    ["safety.weapons", "no version"],
    ["safety.weapons@", "empty version"],
    ["safety.weapons@0", "version 0"],
    ["safety.weapons@01", "leading zero"],
    ["safety.weapons@-1", "negative"],
    ["safety.weapons@1.5", "fraction"],
    ["safety.weapons@1@2", "two @"],
    ["@1", "no id"],
    ["Safety.weapons@1", "upper case"],
    ["1safety@1", "leading digit"],
    [".safety@1", "leading dot"],
    ["safety_weapons@1", "underscore"],
    ["safety weapons@1", "space"],
    [" safety.weapons@1", "leading space"],
    ["safety.weapons@1 ", "trailing space"],
    ["safety.weapons@1\n", "trailing newline"],
    ["safety.weapons@99999999999999999999", "unsafe integer"],
  ])("refuses %j (%s)", (ref) => {
    expect(parseRuleRef(ref)).toBeNull();
  });
});
