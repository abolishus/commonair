// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The facts the jury sampler and the seat draw need, read from the database (ADR 0038 §3-4). The
 * queries only narrow by time and status; `sample.ts` decides every exclusion, and the 0046
 * triggers refuse anything that slips through.
 */
import { clauseFor, clauseRef } from "@commonair/moderation";
import type { REPORT_REASONS } from "@commonair/contracts/enums";
import { schema, type Executor } from "@commonair/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  CLOSED_CASE_STATUSES,
  isKnownAdult,
  RESOLVED_REPORT_STATUSES,
  sampleWindow,
  type CandidateFacts,
  type CandidateParty,
} from "./sample.ts";

const { moderationCases: mc, reports: rp, channels, users, legalHolds, chatMessages, memberships, juryOptins } = schema;

type ReportReason = (typeof REPORT_REASONS)[number];

/** A candidate with what its `jury_cases` row needs besides eligibility. */
export interface CandidateRow extends CandidateFacts {
  /** Whom the case is about, for the `subject` pseudonym (a user, else the subject itself). */
  subjectPartyId: string;
}

/** The clause a report cites: its reason's (`REPORT_REASON_CLAUSES`), as its case would. */
export const reportRuleRef = (reason: ReportReason): string =>
  clauseRef(clauseFor({ action: "moderation.case.warn", category: null, reportReason: reason }));

/** The senders a `message_set` report's evidence names. */
export function messageSenders(evidence: Record<string, unknown>): string[] {
  const list = (evidence as { messages?: unknown }).messages;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) =>
    typeof m === "object" && m !== null && typeof (m as { userId?: unknown }).userId === "string"
      ? [(m as { userId: string }).userId]
      : [],
  );
}

const uniq = (ids: readonly (string | null | undefined)[]): string[] => [
  ...new Set(ids.filter((x): x is string => typeof x === "string")),
];

/** Closed cases and resolved reports in the sample window, with their parties' ages and holds. */
export async function loadCandidates(tx: Executor, now: Date, days?: number): Promise<CandidateRow[]> {
  const { from, to } = sampleWindow(now, days);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const caseClosed = sql`coalesce(${mc.resolvedAt}, ${mc.updatedAt})`;
  const cases = await tx
    .select({
      id: mc.id,
      tier: mc.tier,
      status: mc.status,
      listCategory: mc.listCategory,
      ruleRef: mc.ruleRef,
      subjectId: mc.subjectId,
      userId: mc.userId,
      resolvedAt: mc.resolvedAt,
      updatedAt: mc.updatedAt,
      ownerId: channels.ownerId,
    })
    .from(mc)
    .leftJoin(channels, eq(channels.id, mc.channelId))
    .where(
      and(
        inArray(mc.status, [...CLOSED_CASE_STATUSES]),
        sql`${caseClosed} >= ${fromIso}::timestamptz`,
        sql`${caseClosed} <= ${toIso}::timestamptz`,
      ),
    );
  const reportClosed = sql`coalesce(${rp.resolvedAt}, ${rp.createdAt})`;
  const reports = await tx
    .select({
      id: rp.id,
      status: rp.status,
      reason: rp.reason,
      subjectType: rp.subjectType,
      subjectId: rp.subjectId,
      reporterId: rp.reporterId,
      evidence: rp.evidence,
      resolvedAt: rp.resolvedAt,
      createdAt: rp.createdAt,
      ownerId: channels.ownerId,
    })
    .from(rp)
    .leftJoin(channels, eq(channels.id, rp.channelId))
    .where(
      and(
        inArray(rp.status, [...RESOLVED_REPORT_STATUSES]),
        sql`${reportClosed} >= ${fromIso}::timestamptz`,
        sql`${reportClosed} <= ${toIso}::timestamptz`,
      ),
    );

  const messageIds = reports.filter((r) => r.subjectType === "chat_message").map((r) => r.subjectId);
  const authors = new Map(
    (messageIds.length
      ? await tx
          .select({ id: chatMessages.id, userId: chatMessages.userId })
          .from(chatMessages)
          .where(inArray(chatMessages.id, messageIds))
      : []
    ).map((m) => [m.id, m.userId]),
  );

  // Party lists before ages: (party ids, the reporter, whether one could not be named).
  const caseParties = cases.map((c) => ({ shown: uniq([c.userId, c.ownerId]), reporter: null, unknown: false }));
  const reportParties = reports.map((r) => {
    switch (r.subjectType) {
      case "user":
        return { shown: uniq([r.subjectId, r.ownerId]), reporter: r.reporterId, unknown: false };
      case "chat_message": {
        const author = authors.get(r.subjectId);
        return { shown: uniq([author, r.ownerId]), reporter: r.reporterId, unknown: author === undefined };
      }
      case "message_set": {
        const senders = messageSenders(r.evidence);
        return { shown: uniq([...senders, r.ownerId]), reporter: r.reporterId, unknown: senders.length === 0 };
      }
      default:
        return { shown: uniq([r.ownerId]), reporter: r.reporterId, unknown: false };
    }
  });

  const partyIds = uniq([...caseParties, ...reportParties].flatMap((p) => [...p.shown, p.reporter]));
  const births = new Map<string, string | null>();
  for (let i = 0; i < partyIds.length; i += 1000) {
    const chunk = partyIds.slice(i, i + 1000);
    for (const u of await tx
      .select({ id: users.id, birthDate: users.birthDate })
      .from(users)
      .where(inArray(users.id, chunk)))
      births.set(u.id, u.birthDate);
  }
  const holds = await tx
    .select({ userId: legalHolds.userId, caseId: legalHolds.caseId })
    .from(legalHolds)
    .where(isNull(legalHolds.releasedAt));
  const heldUsers = new Set(holds.map((h) => h.userId));
  const heldCases = new Set(holds.flatMap((h) => (h.caseId ? [h.caseId] : [])));
  const partiesOf = (ids: readonly string[]): CandidateParty[] =>
    ids.map((userId) => ({ userId, birthDate: births.get(userId) ?? null }));

  const out: CandidateRow[] = [];
  cases.forEach((c, i) => {
    const p = caseParties[i] as (typeof caseParties)[number];
    out.push({
      kind: "moderation_case",
      id: c.id,
      closedAt: c.resolvedAt ?? c.updatedAt,
      status: c.status,
      tier: c.tier,
      listCategory: c.listCategory,
      ruleRef: c.ruleRef,
      reportReason: null,
      reportSubjectType: null,
      parties: partiesOf(p.shown),
      partiesUnknown: false,
      legalHold: heldCases.has(c.id) || p.shown.some((u) => heldUsers.has(u)),
      subjectPartyId: c.userId ?? c.ownerId ?? c.subjectId,
    });
  });
  reports.forEach((r, i) => {
    const p = reportParties[i] as (typeof reportParties)[number];
    const all = uniq([...p.shown, p.reporter]);
    const subjectParty =
      r.subjectType === "user"
        ? r.subjectId
        : r.subjectType === "chat_message"
          ? (authors.get(r.subjectId) ?? r.subjectId)
          : r.subjectType === "message_set"
            ? // A set is not a person: name its first sender (a set with none is never sampled).
              (messageSenders(r.evidence)[0] ?? r.ownerId ?? r.subjectId)
            : (r.ownerId ?? r.subjectId);
    out.push({
      kind: "report",
      id: r.id,
      closedAt: r.resolvedAt ?? r.createdAt,
      status: r.status,
      tier: null,
      listCategory: null,
      ruleRef: reportRuleRef(r.reason),
      reportReason: r.reason,
      reportSubjectType: r.subjectType,
      parties: partiesOf(all),
      partiesUnknown: p.unknown,
      legalHold: all.some((u) => heldUsers.has(u)),
      subjectPartyId: subjectParty,
    });
  });
  return out;
}

export interface PoolRow {
  userId: string;
  birthDate: string | null;
}

/**
 * Opted-in users with an active membership (the electorate's definition, 0002), not deleted,
 * banned or suspended, holding no staff role, and human. Adults are kept by `poolEntries`.
 */
export async function loadPool(tx: Executor): Promise<PoolRow[]> {
  return tx
    .selectDistinct({ userId: users.id, birthDate: users.birthDate })
    .from(users)
    .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.status, "active")))
    .innerJoin(juryOptins, and(eq(juryOptins.userId, users.id), isNull(juryOptins.optedOutAt)))
    .where(
      and(isNull(users.deletedAt), eq(users.banned, false), eq(users.role, "user"), eq(users.accountType, "human")),
    );
}

/** The seat draw's entry list: the adults of the pool, sorted by user id (UTF-16 code units). */
export function poolEntries(rows: readonly PoolRow[], now: Date): string[] {
  return [...new Set(rows.filter((r) => isKnownAdult(r.birthDate, now)).map((r) => r.userId))].sort();
}
