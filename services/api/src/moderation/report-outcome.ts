// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `report_outcome` notifications (overhaul wave 4, D7; ux-journeys J5-f; DSA Art. 16(5)): when a
 * report a member filed is decided, its reporter is told the outcome, in the deciding transaction.
 *
 * The payload is the report's id, its subject type and the outcome only: never the moderator, the
 * note, the action taken or anything about the other person. The reported person is never told
 * through this type. One row per report (the dedupe key), so a re-decision or a second decision
 * path (a staff resolve after the case was reviewed) never notifies twice.
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { REPORT_SUBJECTS, type REPORT_OUTCOMES } from "@commonair/contracts/enums";
import type { ReportOutcomeNotificationPayload } from "@commonair/contracts/notify";
import { schema, type Executor } from "@commonair/db";

const { reports, notifications } = schema;

export type ReportOutcome = (typeof REPORT_OUTCOMES)[number];
type ReportSubject = (typeof REPORT_SUBJECTS)[number];

export const reportOutcomeKey = (reportId: string) => `report-outcome-${reportId}`;

export interface DecidedReport {
  id: string;
  reporterId: string | null;
  subjectType: ReportSubject;
}

/**
 * Notify each report's reporter of `outcome`, once per report. `parties` are the people the
 * reports are about (the subject's account, a wave's senders): they are never notified here.
 */
export async function notifyReportOutcomesTx(
  tx: Executor,
  decided: readonly DecidedReport[],
  outcome: ReportOutcome,
  parties: ReadonlySet<string>,
  now: Date,
): Promise<number> {
  const rows = decided.flatMap((r) => {
    if (!r.reporterId || parties.has(r.reporterId)) return [];
    const payload: ReportOutcomeNotificationPayload = { reportId: r.id, subjectType: r.subjectType, outcome };
    return [
      {
        userId: r.reporterId,
        type: "report_outcome" as const,
        payload,
        dedupeKey: reportOutcomeKey(r.id),
        createdAt: now,
      },
    ];
  });
  if (rows.length === 0) return 0;
  const inserted = await tx
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return inserted.length;
}

const isReportSubject = (s: string): s is ReportSubject => (REPORT_SUBJECTS as readonly string[]).includes(s);

/**
 * A moderation case was decided: the open reports about the same subject (the reports that opened
 * or joined the case; one undecided case per subject and tier) learn the outcome.
 */
export async function notifyCaseReportersTx(
  tx: Executor,
  c: { subjectType: string; subjectId: string },
  outcome: ReportOutcome,
  subjectUserId: string | null,
  now: Date,
): Promise<number> {
  if (!isReportSubject(c.subjectType)) return 0;
  const open = await tx
    .select({ id: reports.id, reporterId: reports.reporterId, subjectType: reports.subjectType })
    .from(reports)
    .where(
      and(
        eq(reports.subjectType, c.subjectType),
        eq(reports.subjectId, c.subjectId),
        eq(reports.status, "open"),
        isNotNull(reports.reporterId),
      ),
    );
  return notifyReportOutcomesTx(tx, open, outcome, new Set(subjectUserId ? [subjectUserId] : []), now);
}
