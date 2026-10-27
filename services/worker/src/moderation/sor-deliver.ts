// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Statement delivery (ADR 0019 decision 7): an in-app `notifications` row (payload ids only, as
 * `services/api/src/moderation/notify.ts` requires) and the `enforcementStatement` email in the
 * recipient's locale, each recorded in `enforcement_statement_deliveries`. A sent channel is
 * never sent again (`sent_at`); a failure is retried with exponential backoff
 * (`nextAttemptAt`) up to `MAX_DELIVERY_ATTEMPTS`, so an outage of hours does not use them up;
 * a deleted account or one without an address is skipped with a code.
 * Delivery rows and logs carry ids and codes only, never an address or provider text.
 */
import { sourceLink, type InstanceSite } from "@commonair/config/site";
import { PLACEHOLDER_PATTERN, schema, type Executor } from "@commonair/db";
import type { TemplateData } from "@commonair/email";
import { findClause, noticeRedress, noticeSection, plainNoticeText } from "@commonair/moderation";
import { and, asc, eq, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { safeErrorCode } from "./records.ts";

const { enforcementStatements: st, enforcementStatementDeliveries: dl, legalDocuments, notifications, users } = schema;

/** With `RETRY_BASE_SECONDS` the last attempt comes about 34 hours after the first. */
export const MAX_DELIVERY_ATTEMPTS = 12;
export const RETRY_BASE_SECONDS = 60;

/**
 * When a delivery that has failed `attempts` times is next due: `base · (2^attempts − 1)` after
 * the row was created (0, 1, 3, 7, 15 … minutes). Counted from `created_at` because the table
 * has no per-attempt timestamp; a run that comes late only makes the next wait shorter.
 */
export const nextAttemptAt = (createdAt: Date, attempts: number): Date =>
  new Date(createdAt.getTime() + RETRY_BASE_SECONDS * 1000 * (2 ** attempts - 1));
/** Final outcomes: never retried. */
export const SKIP_CODES = ["account_deleted", "no_email"] as const;
/** Where the statement is listed (`apps/web/src/routes/_app/settings.appeals.tsx`). */
export const APPEALS_PATH = "/settings/appeals";

type StatementRow = typeof st.$inferSelect;

/** Short references the mail quotes (the tail of the id: UUIDv7 heads are timestamps). */
const ref = (prefix: string, id: string) => `${prefix}-${id.replace(/-/g, "").slice(-8).toUpperCase()}`;
export const statementRef = (id: string) => ref("SR", id);

/** `{{placeholders}}` of a legal text, as the API renders them (`services/api/src/lib/legal.ts`). */
export function renderPlaceholders(text: string, site: InstanceSite): string {
  const vars: Record<string, string> = {
    instanceName: site.name,
    publicUrl: site.publicUrl,
    sourceUrl: sourceLink(site),
  };
  for (const [k, v] of Object.entries(site.contacts)) vars[`contacts.${k}`] = v;
  return text.replace(PLACEHOLDER_PATTERN, (whole, key: string) => vars[key] ?? whole);
}

/** The mail for one stored statement, rendered against its pinned notice. */
export function statementMail(
  s: StatementRow,
  notice: { body: string; isDraft: boolean },
  site: InstanceSite,
): TemplateData<"enforcementStatement"> {
  const body = renderPlaceholders(notice.body, site);
  const f = s.facts;
  let facts: TemplateData<"enforcementStatement">["facts"];
  switch (f.code) {
    case "classifier":
      facts = f;
      break;
    case "moderator_review":
      facts = { code: f.code, caseRef: ref("MC", f.caseId), decision: f.decision };
      break;
    case "ncii_notice":
      facts = { code: f.code, requestRef: ref("NR", f.requestId), receivedAt: f.receivedAt, deadlineAt: f.deadlineAt };
      break;
    case "hash_match":
      facts = { code: f.code, capturedAt: f.capturedAt };
      break;
  }
  const clause = findClause(s.clauseId, s.clauseVersion);
  const section = noticeSection(body, s.clauseId);
  const redress = noticeRedress(body);
  return {
    statementRef: statementRef(s.id),
    appliedAt: s.createdAt,
    contentType: s.contentType,
    restrictionKind: s.restrictionKind,
    restrictionDetail: s.restrictionDetail,
    endsAt: s.restrictionEndsAt,
    facts,
    source: s.source,
    automatedDetection: s.automatedDetection,
    automatedDecision: s.automatedDecision,
    groundKind: s.groundKind,
    clauseTitleKey: clause?.titleKey ?? `clause.${s.clauseId}`,
    clauseRef: `${s.clauseId}@${s.clauseVersion}`,
    legalBasis: s.legalBasis,
    explanation: section ? plainNoticeText(section) : "",
    redress: redress ? plainNoticeText(redress) : "",
    appealable: s.appealSubjectType !== null,
    noticeIsDraft: notice.isDraft,
    appealsUrl: `${site.publicUrl.replace(/\/+$/, "")}${APPEALS_PATH}`,
  };
}

export interface DeliveryResult {
  sent: number;
  failed: number;
  skipped: number;
}

async function finish(db: Executor, deliveryId: string, outcome: { sent: Date } | { error: string }): Promise<void> {
  await db
    .update(dl)
    .set(
      "sent" in outcome
        ? { sentAt: outcome.sent, attempts: sql`${dl.attempts} + 1`, lastErrorCode: null }
        : { attempts: sql`${dl.attempts} + 1`, lastErrorCode: outcome.error },
    )
    .where(and(eq(dl.id, deliveryId), isNull(dl.sentAt)));
}

/** One run over unsent, retryable deliveries, oldest first. */
export async function deliverStatements(
  ctx: Pick<WorkerContext, "db" | "logger" | "now" | "mailer" | "site">,
  opts: { limit?: number } = {},
): Promise<DeliveryResult> {
  const out: DeliveryResult = { sent: 0, failed: 0, skipped: 0 };
  const now = ctx.now();
  // Without a mailer (tests, tools) email deliveries wait for a worker that has one; leaving
  // them out of the page keeps a backlog of them from crowding out in-app deliveries.
  const canMail = Boolean(ctx.mailer && ctx.site);
  const rows = await ctx.db
    .select({ d: dl, s: st })
    .from(dl)
    .innerJoin(st, eq(st.id, dl.statementId))
    .where(
      and(
        isNull(dl.sentAt),
        lt(dl.attempts, MAX_DELIVERY_ATTEMPTS),
        or(isNull(dl.lastErrorCode), notInArray(dl.lastErrorCode, [...SKIP_CODES])),
        // `nextAttemptAt`, in SQL. A first attempt is always due: `created_at` is the database's
        // clock, which may run a little ahead of the worker's.
        or(
          eq(dl.attempts, 0),
          sql`${dl.createdAt} + make_interval(secs => ${RETRY_BASE_SECONDS} * (power(2, ${dl.attempts}) - 1)) <= ${now.toISOString()}::timestamptz`,
        ),
        canMail ? undefined : eq(dl.channel, "in_app"),
      ),
    )
    .orderBy(asc(dl.createdAt), asc(dl.id))
    .limit(opts.limit ?? 200);
  const notices = new Map<string, { body: string; isDraft: boolean } | null>();
  const notice = async (id: string) => {
    if (!notices.has(id)) {
      const [n] = await ctx.db
        .select({ body: legalDocuments.body, isDraft: legalDocuments.isDraft })
        .from(legalDocuments)
        .where(eq(legalDocuments.id, id));
      notices.set(id, n ?? null);
    }
    return notices.get(id) ?? null;
  };
  for (const { d, s } of rows) {
    const log = { statementId: s.id, auditId: s.sourceAuditId, channel: d.channel };
    const [user] = await ctx.db
      .select({ email: users.email, locale: users.locale, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, s.recipientUserId));
    const skip = !user || user.deletedAt ? "account_deleted" : d.channel === "email" && !user.email ? "no_email" : null;
    if (skip !== null || !user) {
      await finish(ctx.db, d.id, { error: skip ?? "account_deleted" });
      moderationMetrics.sorDeliveries.add(1, { channel: d.channel, outcome: "skipped" });
      out.skipped += 1;
      continue;
    }
    try {
      if (d.channel === "in_app") {
        const at = ctx.now();
        await ctx.db.transaction(async (tx) => {
          await tx.insert(notifications).values({
            userId: s.recipientUserId,
            type: "moderation",
            payload: { kind: "enforcement_statement", statementId: s.id },
            createdAt: at,
          });
          await finish(tx, d.id, { sent: at });
        });
      } else {
        if (!ctx.mailer || !ctx.site) continue;
        const n = await notice(s.noticeDocumentId);
        if (!n) throw Object.assign(new Error("notice missing"), { code: "NOTICE_MISSING" });
        await ctx.mailer.send(
          "enforcementStatement",
          { ...statementMail(s, n, ctx.site), locale: user.locale },
          user.email,
        );
        await finish(ctx.db, d.id, { sent: ctx.now() });
      }
      moderationMetrics.sorDeliveries.add(1, { channel: d.channel, outcome: "sent" });
      out.sent += 1;
    } catch (err) {
      const code = safeErrorCode(err);
      await finish(ctx.db, d.id, { error: code });
      moderationMetrics.sorDeliveries.add(1, { channel: d.channel, outcome: "failed" });
      out.failed += 1;
      const last = d.attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
      ctx.logger[last ? "error" : "warn"]("statement delivery failed", {
        ...log,
        errorCode: code,
        attempts: d.attempts + 1,
        ...(last ? { alert: "sor_delivery_exhausted" } : {}),
      });
    }
  }
  return out;
}
