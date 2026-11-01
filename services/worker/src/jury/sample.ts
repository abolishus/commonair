// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The advisory jury's sampling rules (ADR 0038 §4, batch 7 decision (u)), pure so each exclusion
 * is unit-tested. The `jury_cases` insert trigger (0046) refuses the same things; this filter is
 * what keeps them out, the trigger is the backstop.
 *
 * Sampled: T1/T2 moderation cases closed as `cleared`, `actioned`, `dismissed` or `confirmed`, and
 * reports resolved `actioned` or `dismissed`, closed in the last `JURY_RULES.sampleDays` (both
 * edges included). Never: T0 or hash-list cases; NCII or minor-safety clauses or reasons;
 * `watch_room` reports; anything with an active legal hold on a party; anything with a party who
 * is not a known adult (a minor, or no valid birth date; fail closed), or a party we cannot name.
 */
import { JURY_RULES, type JURY_SUBJECT_KINDS } from "@commonair/contracts/enums";

export type JurySubjectKind = (typeof JURY_SUBJECT_KINDS)[number];

/** Closed `moderation_cases.status` values (`labelled` is still open, ADR 0038). */
export const CLOSED_CASE_STATUSES = ["cleared", "actioned", "dismissed", "confirmed"] as const;
/** Resolved `reports.status` values. */
export const RESOLVED_REPORT_STATUSES = ["actioned", "dismissed"] as const;
/** Clauses never sampled, whatever the case's origin (NCII and minor safety). */
export const EXCLUDED_CLAUSE_IDS: ReadonlySet<string> = new Set([
  "decency.intimate-images",
  "illegal.ncii",
  "safety.minors",
]);
/** Report reasons never sampled. */
export const EXCLUDED_REPORT_REASONS: ReadonlySet<string> = new Set(["ncii", "minor_safety"]);

const DAY_MS = 86_400_000;

export interface CandidateParty {
  userId: string;
  /** `users.birth_date` (`YYYY-MM-DD`), null when unknown. */
  birthDate: string | null;
}

/** What the sampler knows about one closed case or resolved report. */
export interface CandidateFacts {
  kind: JurySubjectKind;
  id: string;
  /** When it closed (`resolved_at`, else the last update). */
  closedAt: Date;
  status: string;
  /** Moderation cases only. */
  tier: "t0" | "t1" | "t2" | null;
  /** Moderation cases only: a hash-list category (any is excluded). */
  listCategory: string | null;
  /** The clause the case cites (`<id>@<version>`), or the report reason's clause. */
  ruleRef: string | null;
  /** Reports only. */
  reportReason: string | null;
  reportSubjectType: string | null;
  /** Everyone involved: subject user, channel owner, reporter, message authors. */
  parties: readonly CandidateParty[];
  /** A party could not be named (a reported message that is gone): fail closed. */
  partiesUnknown: boolean;
  /** An unreleased legal hold names the case or a party. */
  legalHold: boolean;
}

export type Exclusion =
  | "window"
  | "open"
  | "t0"
  | "hash_list"
  | "ncii"
  | "minor_safety"
  | "watch_room"
  | "legal_hold"
  | "minor"
  | "unknown_party";

/** Inclusive window `[now − sampleDays, now]`. */
export function sampleWindow(now: Date, days: number = JURY_RULES.sampleDays): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

export function inSampleWindow(closedAt: Date, now: Date, days: number = JURY_RULES.sampleDays): boolean {
  const { from, to } = sampleWindow(now, days);
  return closedAt.getTime() >= from.getTime() && closedAt.getTime() <= to.getTime();
}

const BIRTH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 18 or over on `now`'s UTC date, as `commonair_age_band` (0046): a birth date that is missing, in
 * the future or before 1900 is unknown, which is never adult.
 */
export function isKnownAdult(birthDate: string | null, now: Date): boolean {
  if (birthDate === null) return false;
  const m = BIRTH_DATE.exec(birthDate);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const today = now.toISOString().slice(0, 10);
  if (birthDate > today || y < 1900) return false;
  // The 18th birthday as a date string, compared as text: a 29 Feb birthday is adult on 1 Mar of a
  // common year, as `birth_date <= current_date - interval '18 years'` decides.
  const eighteenth = `${String(y + 18).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return eighteenth <= today;
}

const clauseIdOf = (ruleRef: string | null): string | null =>
  ruleRef === null ? null : ruleRef.slice(0, Math.max(0, ruleRef.lastIndexOf("@")));

/** Why a candidate is never sampled, or null when it may be. The first rule that applies wins. */
export function exclusionOf(c: CandidateFacts, now: Date, days: number = JURY_RULES.sampleDays): Exclusion | null {
  if (!inSampleWindow(c.closedAt, now, days)) return "window";
  if (c.kind === "moderation_case") {
    if (c.tier === "t0") return "t0";
    if (c.listCategory !== null) return "hash_list";
    if (!(CLOSED_CASE_STATUSES as readonly string[]).includes(c.status)) return "open";
  } else {
    if (!(RESOLVED_REPORT_STATUSES as readonly string[]).includes(c.status)) return "open";
    if (c.reportSubjectType === "watch_room") return "watch_room";
    if (c.reportReason === "ncii") return "ncii";
    if (c.reportReason === "minor_safety") return "minor_safety";
  }
  const clause = clauseIdOf(c.ruleRef);
  if (clause === "safety.minors") return "minor_safety";
  if (clause !== null && EXCLUDED_CLAUSE_IDS.has(clause)) return "ncii";
  if (c.legalHold) return "legal_hold";
  if (c.partiesUnknown) return "unknown_party";
  if (c.parties.some((p) => !isKnownAdult(p.birthDate, now))) return "minor";
  return null;
}

/** The draw's entry for a candidate: `<kind>:<id>`, sorted by UTF-16 code unit before drawing. */
export const candidateKey = (c: Pick<CandidateFacts, "kind" | "id">): string => `${c.kind}:${c.id}`;

export function parseCandidateKey(key: string): { kind: JurySubjectKind; id: string } {
  const i = key.indexOf(":");
  const kind = key.slice(0, i);
  if (kind !== "moderation_case" && kind !== "report") throw new Error(`not a jury candidate key: ${key}`);
  return { kind, id: key.slice(i + 1) };
}

/** The eligible candidates' keys, sorted and unique: the draw's entry list. */
export function candidateEntries(
  candidates: readonly CandidateFacts[],
  now: Date,
  days: number = JURY_RULES.sampleDays,
): string[] {
  const keys = new Set<string>();
  for (const c of candidates) if (exclusionOf(c, now, days) === null) keys.add(candidateKey(c));
  return [...keys].sort();
}

/** Domain separators: seats and cases are drawn from one seed (ADR 0038 §4). */
export const SEAT_DOMAIN = "jury/seats";
export const CASE_DOMAIN = "jury/cases";

/** A panel is `YYYY-MM` of its draw (UTC). */
export function panelPeriod(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** How long a panel sits before `jury-close` reveals the seed (ADR 0038 decision 8). */
export const PANEL_DAYS = 14;
export const PANEL_MS = PANEL_DAYS * DAY_MS;
