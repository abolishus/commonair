// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.enforcement.list`: the caller's statements of reasons (ADR 0019 decision 8), newest first,
 * keyset cursor on `(created_at, id)` like `me.notifications`. A GET, so a suspended user can
 * still read it. The stored statement never changes; what is computed here is computed on read:
 * the clause title (message catalog), the explanation (the clause's section of the pinned
 * `enforcement_notice`), the moderator's note (`moderation_cases.resolution_note`, never stored
 * in the statement), an existing appeal and whether the decision has since been reversed.
 *
 * A T0 NCII-list statement never joins its T0 case: no note, no reversal from it (appeals hide
 * T0 cases too). CSAM-list matches have no statement, so they never appear.
 */
import type { EnforcementStatement } from "@commonair/contracts/dto";
import type { APPEAL_SUBJECTS } from "@commonair/contracts/enums";
import { en } from "@commonair/email";
import { findClause, noticeSection, plainNoticeText } from "@commonair/moderation";
import { schema } from "@commonair/db";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { iso, isoOrNull } from "../lib/dto.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { legalVariables, renderLegalText } from "../lib/legal.ts";
import { os, requireCaller } from "../lib/orpc.ts";

const { enforcementStatements: st, legalDocuments, moderationCases, appeals } = schema;
type Row = typeof st.$inferSelect;
type AppealSubject = (typeof APPEAL_SUBJECTS)[number];

/** The source actions whose `moderation_case` appeal subject is a case a moderator may later clear. */
const CLEARABLE = new Set(["moderation.t1.restrict", "moderation.t1.upload_reject"]);

/** The clause's plain-language title from the email catalog (the one catalog API, worker and mail share). */
export function clauseTitle(clauseId: string, clauseVersion: number): string {
  const key = findClause(clauseId, clauseVersion)?.titleKey ?? `clause.${clauseId}`;
  const v = (en.enforcementStatement as Record<string, string>)[key];
  return v ?? clauseId;
}

export const meEnforcement = {
  list: os.me.enforcement.list.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await deps.db
      .select()
      .from(st)
      .where(
        and(
          eq(st.recipientUserId, caller.user.id),
          cur
            ? or(lt(st.createdAt, new Date(cur.t)), and(eq(st.createdAt, new Date(cur.t)), lt(st.id, cur.id)))
            : undefined,
        ),
      )
      .orderBy(desc(st.createdAt), desc(st.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);

    const noticeIds = [...new Set(page.map((r) => r.noticeDocumentId))];
    const notices = new Map(
      (noticeIds.length
        ? await deps.db
            .select({ id: legalDocuments.id, body: legalDocuments.body, isDraft: legalDocuments.isDraft })
            .from(legalDocuments)
            .where(inArray(legalDocuments.id, noticeIds))
        : []
      ).map((n) => [n.id, n]),
    );

    // Cases joined for the note and the clear: moderator decisions and T1 statements only. T0
    // (hash_match) statements carry no appeal subject and are never joined.
    const caseIds = [
      ...new Set(
        page.flatMap((r) =>
          r.appealSubjectType === "moderation_case" && r.appealSubjectId && r.facts.code !== "hash_match"
            ? [r.appealSubjectId]
            : [],
        ),
      ),
    ];
    const cases = new Map(
      (caseIds.length
        ? await deps.db
            .select({
              id: moderationCases.id,
              tier: moderationCases.tier,
              resolution: moderationCases.resolution,
              resolutionNote: moderationCases.resolutionNote,
              resolvedAt: moderationCases.resolvedAt,
            })
            .from(moderationCases)
            .where(inArray(moderationCases.id, caseIds))
        : []
      ).map((c) => [c.id, c]),
    );

    const subjectIds = [...new Set(page.flatMap((r) => (r.appealSubjectId ? [r.appealSubjectId] : [])))];
    const mine = subjectIds.length
      ? await deps.db
          .select({
            id: appeals.id,
            subjectType: appeals.subjectType,
            subjectId: appeals.subjectId,
            status: appeals.status,
            resolvedAt: appeals.resolvedAt,
          })
          .from(appeals)
          .where(
            and(
              eq(appeals.appellantId, caller.user.id),
              eq(appeals.kind, "moderation"),
              inArray(appeals.subjectId, subjectIds),
            ),
          )
          .orderBy(desc(appeals.createdAt), desc(appeals.id))
      : [];

    const vars = legalVariables(deps.site, deps.env.AUTH_MIN_AGE, deps.env);
    const explanation = (r: Row): string => {
      const n = notices.get(r.noticeDocumentId);
      const section = n ? noticeSection(renderLegalText(n.body, vars), r.clauseId) : null;
      return section ? plainNoticeText(section) : "";
    };

    return pageOf(
      rows,
      input.limit,
      (r) => {
        const subject =
          r.appealSubjectType && r.appealSubjectId ? { type: r.appealSubjectType, id: r.appealSubjectId } : null;
        const appealsOn = subject
          ? mine.filter((a) => a.subjectType === subject.type && a.subjectId === subject.id)
          : [];
        const c = subject?.type === "moderation_case" ? cases.get(subject.id) : undefined;
        const tierOk = c !== undefined && c.tier !== "t0";
        const overturned = appealsOn.find((a) => a.status === "overturned");
        const cleared = tierOk && CLEARABLE.has(r.sourceAction) && c.resolution === "clear" ? c.resolvedAt : null;
        const reversedAt = overturned?.resolvedAt ?? cleared ?? null;
        const moderatorNote = tierOk && r.facts.code === "moderator_review" ? (c.resolutionNote ?? null) : null;
        return {
          id: r.id,
          sourceAuditId: r.sourceAuditId,
          sourceAction: r.sourceAction as EnforcementStatement["sourceAction"],
          recipientUserId: r.recipientUserId,
          channelId: r.channelId,
          content: { type: r.contentType, id: r.contentId },
          restriction: {
            kind: r.restrictionKind,
            detail: r.restrictionDetail,
            endsAt: isoOrNull(r.restrictionEndsAt),
            territorialScope: "all" as const,
          },
          facts: r.facts,
          source: r.source,
          automatedDetection: r.automatedDetection,
          automatedDecision: r.automatedDecision,
          ground: {
            kind: r.groundKind,
            clauseId: r.clauseId,
            clauseVersion: r.clauseVersion,
            legalBasis: r.legalBasis,
          },
          documents: { guidelinesId: r.guidelinesDocumentId, noticeId: r.noticeDocumentId },
          // A case escalated to T0 since is hidden from appeals (`appeals.create` answers
          // NOT_FOUND), so the statement stops offering one.
          appeal:
            subject && !(c !== undefined && c.tier === "t0")
              ? { kind: "moderation" as const, subjectType: subject.type as AppealSubject, subjectId: subject.id }
              : null,
          createdAt: iso(r.createdAt),
          clauseTitle: clauseTitle(r.clauseId, r.clauseVersion),
          explanation: explanation(r),
          noticeIsDraft: notices.get(r.noticeDocumentId)?.isDraft ?? true,
          moderatorNote,
          appealId: appealsOn[0]?.id ?? null,
          reversedAt: isoOrNull(reversedAt),
        };
      },
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
  }),
};
