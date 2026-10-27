// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The clause catalog for statements of reasons (ADR 0019 decision 1, DSA Art. 17): every rule a
 * platform action can cite, as a stable `id@version`, and the pure mapping from a source audit
 * action to its clause. Wording lives elsewhere: the plain-language title in the message
 * catalogs (`titleKey`) and the explanation in the operator-editable `enforcement_notice` legal
 * document (`noticeSection`). NOT REVIEWED BY COUNSEL: the clause set, the grounds and the
 * legal-basis codes are a draft for the L1 legal review.
 *
 * A released `id@version` never changes its meaning, ground or legal basis: a change is a new
 * version appended here, and old versions stay so statements that cite them still resolve
 * (`tests/reasons.test.ts` checks this against a committed snapshot). Pure: no database or I/O,
 * so the API, the worker and W2's report can all import it.
 */
import type { ModerationCategory, REPORT_REASONS } from "@commonair/contracts/enums";

export type ClauseGround = "terms" | "illegal";

export interface Clause {
  /** Stable slug: `<area>.<rule>`. Never reused for a different rule. */
  id: string;
  /** Bumped when the clause's meaning changes; the old version stays in `CLAUSES`. */
  version: number;
  /** Art. 17(3)(d)/(e): a contractual (terms) or an illegal-content ground. */
  ground: ClauseGround;
  /** The community guidelines heading the clause cites (`guidelines.md`, slugged). */
  guidelinesAnchor: string;
  /** Illegal grounds only: a code for the law relied on (counsel to confirm). */
  legalBasis?: string;
  /** Key of the clause's plain-language title in the message catalogs (`enforcementStatement`). */
  titleKey: string;
}

const terms = (id: string, guidelinesAnchor: string): Clause => ({
  id,
  version: 1,
  ground: "terms",
  guidelinesAnchor,
  titleKey: `clause.${id}`,
});

/** Every clause ever released, all versions. Append only. */
export const CLAUSES: readonly Clause[] = [
  terms("mature.unlabelled", "label-mature-content"),
  terms("safety.sexual-explicit", "label-mature-content"),
  terms("safety.graphic-violence", "keep-it-safe"),
  terms("safety.weapons", "keep-it-safe"),
  terms("safety.self-harm", "keep-it-safe"),
  terms("safety.violence", "keep-it-safe"),
  terms("safety.minors", "keep-it-safe"),
  terms("safety.illegal-activity", "keep-it-safe"),
  terms("decency.harassment", "be-decent-to-people"),
  terms("decency.hate", "be-decent-to-people"),
  terms("honesty.impersonation", "be-honest"),
  terms("honesty.spam", "be-honest"),
  terms("creative.copyright", "respect-creative-work"),
  terms("guidelines.general", "what-happens-when-rules-are-broken"),
  {
    id: "illegal.ncii",
    version: 1,
    ground: "illegal",
    guidelinesAnchor: "be-decent-to-people",
    legalBasis: "us.take-it-down",
    titleKey: "clause.illegal.ncii",
  },
];

/** Every legal-basis code a clause may carry (the message catalogs label each). */
export const LEGAL_BASIS_CODES = ["us.take-it-down"] as const;

export const clauseRef = (c: Pick<Clause, "id" | "version">) => `${c.id}@${c.version}`;

/** The newest version of `id`, or undefined. */
export function currentClause(id: string): Clause | undefined {
  let best: Clause | undefined;
  for (const c of CLAUSES) if (c.id === id && (!best || c.version > best.version)) best = c;
  return best;
}

/** One exact `id@version` (a statement's citation), or undefined. */
export const findClause = (id: string, version: number): Clause | undefined =>
  CLAUSES.find((c) => c.id === id && c.version === version);

function mustClause(id: string): Clause {
  const c = currentClause(id);
  if (!c) throw new Error(`no clause ${id}`);
  return c;
}

/** T1 classifier categories (live frames and uploads). */
export const CATEGORY_CLAUSES: Readonly<Record<ModerationCategory, string>> = {
  sexual: "safety.sexual-explicit",
  graphic_violence: "safety.graphic-violence",
  weapons: "safety.weapons",
  self_harm: "safety.self-harm",
};

type ReportReason = (typeof REPORT_REASONS)[number];

/** What a moderator decision on a report-origin (human) case cites: the report's reason. */
export const REPORT_REASON_CLAUSES: Readonly<Record<ReportReason, string>> = {
  spam: "honesty.spam",
  harassment: "decency.harassment",
  hate: "decency.hate",
  sexual_content: "safety.sexual-explicit",
  minor_safety: "safety.minors",
  violence: "safety.violence",
  self_harm: "safety.self-harm",
  // A moderator applies the guidelines' rule against illegal activity, not a finding of law.
  illegal: "safety.illegal-activity",
  impersonation: "honesty.impersonation",
  copyright: "creative.copyright",
  unlabeled_mature: "mature.unlabelled",
  ncii: "illegal.ncii",
  other: "guidelines.general",
};

/** The clause a T2 label cites: content that needed the mature label and did not have it. */
export const T2_CLAUSE_ID = "mature.unlabelled";
/** NCII removals, auto-hides and T0 NCII-list matches. */
export const NCII_CLAUSE_ID = "illegal.ncii";
/** A moderator decision with neither a classifier category nor a report reason. */
export const FALLBACK_CLAUSE_ID = "guidelines.general";

/** The source action plus the facts its clause depends on (ADR 0019 decision 3). */
export type ClauseInput =
  | { action: "moderation.t1.restrict" | "moderation.t1.upload_reject"; category: ModerationCategory }
  | { action: "moderation.t2.label" }
  | {
      action: "moderation.case.warn" | "moderation.case.end_stream" | "moderation.case.suspend";
      /** The case's classifier category (classifier-origin cases). */
      category: ModerationCategory | null;
      /** The reason of the report that opened the case (human-origin cases). */
      reportReason: ReportReason | null;
    }
  | { action: "ncii.decide" | "ncii.auto_hide" }
  | { action: "moderation.t0.match"; listCategory: "ncii" };

/** The clause a statement for this action cites. */
export function clauseFor(input: ClauseInput): Clause {
  switch (input.action) {
    case "moderation.t1.restrict":
    case "moderation.t1.upload_reject":
      return mustClause(CATEGORY_CLAUSES[input.category]);
    case "moderation.t2.label":
      return mustClause(T2_CLAUSE_ID);
    case "moderation.case.warn":
    case "moderation.case.end_stream":
    case "moderation.case.suspend":
      if (input.category) return mustClause(CATEGORY_CLAUSES[input.category]);
      if (input.reportReason) return mustClause(REPORT_REASON_CLAUSES[input.reportReason]);
      return mustClause(FALLBACK_CLAUSE_ID);
    case "ncii.decide":
    case "ncii.auto_hide":
    case "moderation.t0.match":
      return mustClause(NCII_CLAUSE_ID);
  }
}

/** `clauseFor` as the statement's ground (Art. 17(3)(d)/(e)). */
export function groundFor(input: ClauseInput): {
  kind: ClauseGround;
  clauseId: string;
  clauseVersion: number;
  legalBasis: string | null;
} {
  const c = clauseFor(input);
  return { kind: c.ground, clauseId: c.id, clauseVersion: c.version, legalBasis: c.legalBasis ?? null };
}

/* ------------------------------------------------------------------------- *
 * The `enforcement_notice` document: one section per clause, marked with an HTML comment
 * (`<!-- clause: mature.unlabelled -->`) so operators can reword headings freely, plus a
 * `<!-- section: redress -->` section. A section runs from its marker to the next marker or the
 * next heading of the same or a higher level than the first heading inside it.
 * ------------------------------------------------------------------------- */

const MARKER = /^<!--\s*(clause|section):\s*([a-z0-9.-]+)\s*-->\s*$/;

function sectionAfter(body: string, kind: "clause" | "section", name: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => {
    const m = MARKER.exec(l.trim());
    return m !== null && m[1] === kind && m[2] === name;
  });
  if (start < 0) return null;
  const out: string[] = [];
  // The heading level of the section's own title; 7 (every heading ends it) when it has none.
  let level: number | null = null;
  for (const line of lines.slice(start + 1)) {
    if (MARKER.test(line.trim())) break;
    const h = /^(#{1,6})\s/.exec(line);
    if (level === null && line.trim() !== "") {
      level = h?.[1] ? h[1].length : 7;
      // The section's own heading is the title, not explanation text.
      if (h) continue;
    } else if (h?.[1] && level !== null && h[1].length <= level) break;
    out.push(line);
  }
  const text = out.join("\n").trim();
  return text === "" ? null : text;
}

/** The explanation of `clauseId` in a notice body, or null when the notice has no such section. */
export const noticeSection = (body: string, clauseId: string): string | null => sectionAfter(body, "clause", clauseId);

/**
 * A notice section as plain text for mail and the API: emphasis, inline code and heading marks
 * dropped, hard-wrapped lines joined into paragraphs. Links stay as written (their text).
 */
export function plainNoticeText(markdown: string): string {
  return markdown
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split("\n")
        .map((l) => l.replace(/^#{1,6}\s+/, "").trim())
        .join(" ")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(^|\W)\*([^*\s][^*]*)\*(?=\W|$)/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((p) => p !== "")
    .join("\n\n");
}

/** The notice's redress paragraph (internal appeal, out-of-court body, courts), or null. */
export const noticeRedress = (body: string): string | null => sectionAfter(body, "section", "redress");
