// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The statement-of-reasons mail (ADR 0019 decision 7): every DSA Art. 17(3) element on its own. */
import { describe, expect, test } from "vite-plus/test";
// The catalog module is pure (no dependencies beyond contract types), so the test reads it by
// path rather than adding a package dependency.
import { CLAUSES, LEGAL_BASIS_CODES } from "../../moderation/src/reasons.ts";
import { en, renderEmail, sampleData, type SampleData } from "../src/index.ts";
import { testSite } from "./fixtures.ts";

const site = testSite();
const base = sampleData(site.publicUrl).enforcementStatement;
const m = en.enforcementStatement;
const render = (data: Partial<SampleData["enforcementStatement"]> = {}) =>
  renderEmail("enforcementStatement", { ...base, ...data }, { site });

describe("enforcementStatement", () => {
  test("carries restriction, end, scope, facts, source, automation, ground, explanation and redress", async () => {
    const mail = await render();
    expect(mail.subject).toBe(`Statement of reasons: ${m["restriction.visibility.restricted"]}`);
    for (const s of [
      base.statementRef,
      m["restriction.visibility.restricted"],
      m.endsIndefinite,
      m.scopeAll.replace("{instance}", site.name),
      m["category.weapons"],
      "95%",
      m.sourceOwn,
      m.detectionYes,
      m.decisionFully,
      m["clause.safety.weapons"],
      "safety.weapons@1",
      base.explanation,
      m.redressHeading,
      m.appeal,
      base.redress,
      m.courts,
      `${site.publicUrl}/settings/appeals`,
    ])
      expect(mail.text, s).toContain(s);
    // The governance threshold in force, never a score.
    expect(mail.text).not.toMatch(/score/i);
  });

  test("says when the notice text was an unreviewed draft, and only then", async () => {
    expect((await render()).text).toContain(m.draft);
    expect((await render({ noticeIsDraft: false })).text).not.toContain(m.draft);
  });

  test("an illegal ground names the law; a T0 NCII-list match points at the contact, not an appeal", async () => {
    const mail = await render({
      contentType: "vod",
      restrictionKind: "account",
      restrictionDetail: "suspended",
      facts: { code: "hash_match", capturedAt: "2026-10-18T14:30:00Z" },
      groundKind: "illegal",
      clauseTitleKey: "clause.illegal.ncii",
      clauseRef: "illegal.ncii@1",
      legalBasis: "us.take-it-down",
      appealable: false,
    });
    expect(mail.text).toContain(m["clause.illegal.ncii"]);
    expect(mail.text).toContain(m["legalBasis.us.take-it-down"]);
    expect(mail.text).toContain(m["restriction.account.suspended"]);
    expect(mail.text).not.toContain(m.appeal);
    expect(mail.text).toContain(site.contacts.abuse);
    expect(mail.text).toContain(m.courts);
  });

  test("a timed suspension shows its end; a warning restricts nothing", async () => {
    const timed = await render({
      restrictionKind: "service",
      restrictionDetail: "suspended",
      endsAt: "2026-10-25T14:30:00Z",
      facts: { code: "moderator_review", caseRef: "MC-0001", decision: "suspend" },
      automatedDecision: "not",
    });
    expect(timed.text).toContain("October 25, 2026");
    expect(timed.text).toContain("MC-0001");
    expect(timed.text).toContain(m["decision.suspend"]);
    expect(timed.text).toContain(m.decisionNot);
    const warning = await render({ restrictionKind: "warning", restrictionDetail: "none" });
    expect(warning.text).toContain(m.endsNotApplicable);
    expect(warning.subject).toContain(m["restriction.warning.none"]);
  });

  test("an NCII notice names the request and its times, never who sent it", async () => {
    const mail = await render({
      facts: {
        code: "ncii_notice",
        requestRef: "NR-0001",
        receivedAt: "2026-10-18T14:30:00Z",
        deadlineAt: "2026-10-20T14:30:00Z",
      },
      source: "notice_art16",
      automatedDetection: false,
      automatedDecision: "not",
    });
    expect(mail.text).toContain("NR-0001");
    expect(mail.text).toContain("October 20, 2026");
    expect(mail.text).toContain(m.sourceNotice);
    expect(mail.text).toContain(m.detectionNo);
  });

  test("operator text is escaped", async () => {
    const mail = await render({ explanation: "<script>alert(1)</script>" });
    expect(mail.html).not.toContain("<script>");
  });

  test("every clause and legal basis of the catalog has its label in this block", () => {
    const labels = m as Record<string, string>;
    for (const c of CLAUSES) expect(labels[c.titleKey], c.id).toBeTruthy();
    for (const b of LEGAL_BASIS_CODES) expect(labels[`legalBasis.${b}`], b).toBeTruthy();
  });
});
