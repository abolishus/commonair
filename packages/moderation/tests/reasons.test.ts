// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The clause catalog (ADR 0019 decision 1): released `id@version`s are immutable. */
import { readFileSync } from "node:fs";
import {
  ENFORCEMENT_SOURCE_ACTIONS,
  MOD_ACTIONS,
  MODERATION_CATEGORIES,
  REPORT_REASONS,
} from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import {
  CATEGORY_CLAUSES,
  CLAUSES,
  clauseFor,
  clauseRef,
  currentClause,
  findClause,
  groundFor,
  LEGAL_BASIS_CODES,
  NCII_CLAUSE_ID,
  noticeRedress,
  noticeSection,
  plainNoticeText,
  REPORT_REASON_CLAUSES,
  type Clause,
} from "../src/reasons.ts";

interface Released {
  id: string;
  version: number;
  ground: string;
  legalBasis: string | null;
}
const RELEASED = JSON.parse(readFileSync(new URL("./reasons.snapshot.json", import.meta.url), "utf8")) as Released[];
const shape = (c: Clause): Released => ({
  id: c.id,
  version: c.version,
  ground: c.ground,
  legalBasis: c.legalBasis ?? null,
});

describe("catalog", () => {
  test("no released id@version changed its id, version, ground or legal basis, and none was removed", () => {
    for (const r of RELEASED) {
      const c = findClause(r.id, r.version);
      expect(c, `${r.id}@${r.version} was removed`).toBeDefined();
      expect(shape(c as Clause)).toEqual(r);
    }
  });

  test("every clause in the catalog is in the committed snapshot (adding one is a deliberate change)", () => {
    const released = new Set(RELEASED.map((r) => `${r.id}@${r.version}`));
    for (const c of CLAUSES) expect(released.has(clauseRef(c)), `${clauseRef(c)} missing from the snapshot`).toBe(true);
    expect(CLAUSES).toHaveLength(RELEASED.length);
  });

  test("ids are unique per version, slugs are well formed, versions start at 1 and are contiguous", () => {
    const refs = CLAUSES.map(clauseRef);
    expect(new Set(refs).size).toBe(refs.length);
    for (const c of CLAUSES) {
      expect(c.id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
      expect(c.version).toBeGreaterThanOrEqual(1);
      expect(c.titleKey).toBe(`clause.${c.id}`);
      expect(c.guidelinesAnchor).toMatch(/^[a-z0-9-]+$/);
      for (let v = 1; v < c.version; v++) expect(findClause(c.id, v)).toBeDefined();
    }
  });

  test("legal bases appear on illegal grounds only, and every one is a known code", () => {
    const codes = LEGAL_BASIS_CODES as readonly string[];
    expect(CLAUSES.filter((c) => c.ground === "terms" && c.legalBasis !== undefined)).toEqual([]);
    expect(CLAUSES.filter((c) => c.ground === "illegal" && !codes.includes(c.legalBasis ?? ""))).toEqual([]);
  });

  test("currentClause picks the newest version", () => {
    expect(currentClause("mature.unlabelled")?.version).toBe(1);
    expect(currentClause("nope")).toBeUndefined();
  });

  test("every guidelines anchor is a heading of the seeded guidelines", () => {
    const guidelines = readFileSync(new URL("../../db/src/legal/guidelines.md", import.meta.url), "utf8");
    const anchors = new Set(
      [...guidelines.matchAll(/^## (.+)$/gm)].map((m) =>
        (m[1] ?? "")
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, "")
          .trim()
          .replace(/\s+/g, "-"),
      ),
    );
    for (const c of CLAUSES) expect(anchors, c.id).toContain(c.guidelinesAnchor);
  });
});

describe("mappings", () => {
  test("every moderation category maps to a released terms clause", () => {
    for (const cat of MODERATION_CATEGORIES) {
      const c = currentClause(CATEGORY_CLAUSES[cat]);
      expect(c, cat).toBeDefined();
      expect(c?.ground).toBe("terms");
    }
  });

  test("every report reason maps to a released clause", () => {
    for (const r of REPORT_REASONS) expect(currentClause(REPORT_REASON_CLAUSES[r]), r).toBeDefined();
  });

  test("per source action", () => {
    expect(clauseFor({ action: "moderation.t1.restrict", category: "weapons" }).id).toBe("safety.weapons");
    expect(clauseFor({ action: "moderation.t1.upload_reject", category: "sexual" }).id).toBe("safety.sexual-explicit");
    expect(clauseFor({ action: "moderation.t2.label" }).id).toBe("mature.unlabelled");
    expect(clauseFor({ action: "moderation.case.warn", category: "self_harm", reportReason: null }).id).toBe(
      "safety.self-harm",
    );
    // A category wins over a report reason; a report reason over the fallback.
    expect(
      clauseFor({ action: "moderation.case.suspend", category: "graphic_violence", reportReason: "spam" }).id,
    ).toBe("safety.graphic-violence");
    expect(clauseFor({ action: "moderation.case.end_stream", category: null, reportReason: "hate" }).id).toBe(
      "decency.hate",
    );
    expect(clauseFor({ action: "moderation.case.warn", category: null, reportReason: null }).id).toBe(
      "guidelines.general",
    );
    for (const action of ["ncii.decide", "ncii.auto_hide"] as const)
      expect(clauseFor({ action }).id).toBe(NCII_CLAUSE_ID);
    expect(groundFor({ action: "moderation.t0.match", listCategory: "ncii" })).toEqual({
      kind: "illegal",
      clauseId: "illegal.ncii",
      clauseVersion: 1,
      legalBasis: "us.take-it-down",
    });
    expect(groundFor({ action: "moderation.t2.label" })).toEqual({
      kind: "terms",
      clauseId: "mature.unlabelled",
      clauseVersion: 1,
      legalBasis: null,
    });
  });

  test("the allowlist holds platform actions only: no channel-moderation action name", () => {
    for (const a of ENFORCEMENT_SOURCE_ACTIONS) {
      expect(a).toMatch(/^(moderation|ncii)\./);
      expect(MOD_ACTIONS as readonly string[]).not.toContain(a);
      expect(a).not.toMatch(/^(chat|channel|channels)\./);
    }
    const allow = ENFORCEMENT_SOURCE_ACTIONS as readonly string[];
    for (const none of ["moderation.t1.flag", "moderation.case.clear", "moderation.case.escalate_legal"])
      expect(allow).not.toContain(none);
  });
});

describe("notice sections", () => {
  const body = [
    "> **Draft pending lawyer review.**",
    "",
    "## Clauses",
    "",
    "<!-- clause: mature.unlabelled -->",
    "### Unlabelled mature content",
    "",
    "Mature content needs the **mature** label.",
    "",
    "#### Detail",
    "Still part of it.",
    "",
    "<!-- clause: illegal.ncii -->",
    "### Intimate images",
    "",
    "Shared without consent.",
    "",
    "## How to challenge",
    "",
    "<!-- section: redress -->",
    "Appeal, an out-of-court body, or the courts.",
    "",
    "## Later",
    "Not redress.",
  ].join("\n");

  test("a clause section runs to the next marker and skips its own heading", () => {
    expect(noticeSection(body, "mature.unlabelled")).toBe(
      "Mature content needs the **mature** label.\n\n#### Detail\nStill part of it.",
    );
  });

  test("a section stops at a heading of its own level or higher", () => {
    expect(noticeSection(body, "illegal.ncii")).toBe("Shared without consent.");
    expect(noticeRedress(body)).toBe("Appeal, an out-of-court body, or the courts.");
  });

  test("plain text drops emphasis and joins wrapped lines", () => {
    const md = "Mature content needs\nthe **mature** label and `code`.\n\n#### Detail\n*Still* [here](x).";
    expect(plainNoticeText(md)).toBe("Mature content needs the mature label and code.\n\nDetail Still here (x).");
  });

  test("a missing or empty section is null", () => {
    expect(noticeSection(body, "safety.weapons")).toBeNull();
    expect(noticeSection("<!-- clause: safety.weapons -->\n### Weapons\n", "safety.weapons")).toBeNull();
    expect(noticeRedress("")).toBeNull();
  });

  test("the shipped notice has a section for every current clause and a redress section", () => {
    const shipped = readFileSync(new URL("../../db/src/legal/enforcement_notice.md", import.meta.url), "utf8");
    for (const c of CLAUSES) expect(noticeSection(shipped, c.id), c.id).not.toBeNull();
    expect(noticeRedress(shipped)).not.toBeNull();
    expect(shipped).toContain("Draft pending lawyer review");
  });
});
