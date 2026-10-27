// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Statements of reasons (ADR 0019 decisions 3–6, docs/testing/w0-selectors.md "Statements of
 * reasons"): turn allowlisted `audit_log` rows into append-only `enforcement_statements`, one per
 * recipient. `planStatements` is the mapping (one case per row of decision 3) over a lookup
 * interface, so unit tests run it on writer fixtures without a database; `buildStatements` is
 * the job body.
 *
 * Rows hold ids, enums, timestamps and catalog codes only (ADR 0004): never the classifier score
 * (the governance threshold in force instead), never a moderator's note (the API joins it on
 * read), never the NCII requester, a hash, a match distance or a provider identifier.
 */
import { EnforcementStatement } from "@commonair/contracts/dto";
import { REPORT_REASONS, type MODERATION_SUBJECTS, type ModerationCategory } from "@commonair/contracts/enums";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { groundFor, parseThresholds, type ClauseInput, type Thresholds } from "@commonair/moderation";
import { and, asc, desc, eq, gt, gte, isNotNull, lte, notInArray, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "./metrics.ts";
import { allowlisted, expectsStatement, isSourceAction, SOR_DETAILS, type SorDetails } from "./sor-schemas.ts";
import { THRESHOLDS_KEY } from "./settings.ts";

const {
  auditLog,
  enforcementStatements,
  enforcementStatementDeliveries,
  moderationCases,
  moderationFlags,
  channels,
  broadcasts,
  vods,
  clips,
  nciiRequests,
  nciiRequestItems,
  legalDocuments,
  governanceSettings,
  governanceSettingsHistory,
} = schema;

export type AuditRow = Pick<typeof auditLog.$inferSelect, "id" | "action" | "channelId" | "details" | "createdAt">;
export type Statement = EnforcementStatement;
type ReportReason = (typeof REPORT_REASONS)[number];
type Subject = (typeof MODERATION_SUBJECTS)[number];

export interface CaseFacts {
  origin: "hash_list" | "classifier" | "human";
  category: ModerationCategory | null;
  subjectType: Subject;
  subjectId: string;
  userId: string | null;
  channelId: string | null;
}

export interface NciiItem {
  id: string;
  subjectType: Subject;
  subjectId: string;
}

/** Everything `planStatements` reads besides the audit row. */
export interface SorLookup {
  documents: { guidelinesId: string; noticeId: string };
  thresholdsAt(at: Date): Promise<Thresholds>;
  moderationCase(id: string): Promise<CaseFacts | null>;
  channelOwner(channelId: string): Promise<string | null>;
  /** The reason of the report that opened a human-origin case (`moderation.case.report`). */
  reportReason(caseId: string): Promise<ReportReason | null>;
  flagCapturedAt(flagId: string): Promise<Date | null>;
  nciiRequest(id: string): Promise<{ receivedAt: Date; deadlineAt: Date } | null>;
  /** The request's items that this action restricted, oldest first. */
  nciiItems(requestId: string, which: "removed" | "hidden"): Promise<NciiItem[]>;
  /** The channel an NCII item's content is on, and its owner. */
  itemOwner(item: NciiItem): Promise<{ channelId: string; ownerId: string } | null>;
}

export type Plan =
  | { kind: "statements"; statements: Statement[] }
  | { kind: "none"; reason: string }
  | { kind: "invalid"; reason: string };

const iso = (d: Date) => d.toISOString();

type Base = Omit<Statement, "id" | "recipientUserId" | "channelId" | "content" | "restriction" | "appeal"> & {
  appeal: Statement["appeal"];
};

function statement(
  base: Base,
  s: {
    recipientUserId: string;
    channelId: string | null;
    content: Statement["content"];
    restriction: Omit<Statement["restriction"], "territorialScope">;
    appeal?: Statement["appeal"];
  },
): Statement {
  // Validated by the shared schema before it can reach the table.
  return EnforcementStatement.parse({
    ...base,
    id: uuidv7(),
    recipientUserId: s.recipientUserId,
    channelId: s.channelId,
    content: s.content,
    restriction: { ...s.restriction, territorialScope: "all" },
    appeal: s.appeal === undefined ? base.appeal : s.appeal,
  });
}

function common(
  row: AuditRow,
  l: SorLookup,
  input: ClauseInput,
  rest: Pick<Statement, "facts" | "source" | "automatedDetection" | "automatedDecision" | "appeal">,
): Base {
  const action = row.action as Statement["sourceAction"];
  return {
    sourceAuditId: row.id,
    sourceAction: action,
    ground: groundFor(input),
    documents: l.documents,
    createdAt: iso(row.createdAt),
    ...rest,
  };
}

const caseAppeal = (caseId: string): Statement["appeal"] => ({
  kind: "moderation",
  subjectType: "moderation_case",
  subjectId: caseId,
});

async function caseRecipient(c: CaseFacts, l: SorLookup): Promise<string | null> {
  if (c.userId) return c.userId;
  return c.channelId ? l.channelOwner(c.channelId) : null;
}

/**
 * The statements one audit row produces (ADR 0019 decision 3), or why it produces none. `invalid`
 * is a row the builder cannot read (details drifted from the writer's shape, or a recipient that
 * no longer resolves): skipped, counted and logged, and the coverage sweep keeps reporting it.
 */
export async function planStatements(row: AuditRow, l: SorLookup): Promise<Plan> {
  if (!isSourceAction(row.action)) return { kind: "none", reason: "not_allowlisted" };
  const parsed = SOR_DETAILS[row.action].safeParse(row.details);
  if (!parsed.success) return { kind: "invalid", reason: "details" };
  const d = parsed.data;
  switch (row.action) {
    case "moderation.t1.restrict": {
      const x = d as SorDetails["moderation.t1.restrict"];
      const c = await l.moderationCase(x.caseId);
      const recipient = c ? await caseRecipient(c, l) : null;
      if (!recipient) return { kind: "invalid", reason: "recipient" };
      const t = await l.thresholdsAt(row.createdAt);
      const capturedAt = (await l.flagCapturedAt(x.flagId)) ?? row.createdAt;
      const base = common(
        row,
        l,
        { action: row.action, category: x.category },
        {
          facts: {
            code: "classifier",
            category: x.category,
            tier: "t1",
            threshold: t.t1[x.category],
            capturedAt: iso(capturedAt),
          },
          source: "own_initiative",
          automatedDetection: true,
          automatedDecision: "fully",
          appeal: caseAppeal(x.caseId),
        },
      );
      return {
        kind: "statements",
        statements: [
          statement(base, {
            recipientUserId: recipient,
            channelId: row.channelId ?? c?.channelId ?? null,
            content: { type: "broadcast", id: x.broadcastId },
            restriction: { kind: "visibility", detail: "restricted", endsAt: null },
          }),
        ],
      };
    }
    case "moderation.t2.label": {
      const x = d as SorDetails["moderation.t2.label"];
      const c = await l.moderationCase(x.caseId);
      const recipient = c ? await caseRecipient(c, l) : row.channelId ? await l.channelOwner(row.channelId) : null;
      if (!recipient) return { kind: "invalid", reason: "recipient" };
      const t = await l.thresholdsAt(row.createdAt);
      const capturedAt = (await l.flagCapturedAt(x.flagId)) ?? row.createdAt;
      const base = common(
        row,
        l,
        { action: row.action },
        {
          facts: {
            code: "classifier",
            category: "sexual",
            tier: "t2",
            threshold: t.t2.sexual,
            capturedAt: iso(capturedAt),
          },
          source: "own_initiative",
          automatedDetection: true,
          automatedDecision: "fully",
          appeal: { kind: "moderation", subjectType: "content_label", subjectId: x.labelId },
        },
      );
      return {
        kind: "statements",
        statements: [
          statement(base, {
            recipientUserId: recipient,
            channelId: row.channelId ?? c?.channelId ?? null,
            content: { type: "broadcast", id: x.broadcastId },
            restriction: { kind: "visibility", detail: "age_gated", endsAt: null },
          }),
        ],
      };
    }
    case "moderation.t1.upload_reject": {
      const x = d as SorDetails["moderation.t1.upload_reject"];
      const t = await l.thresholdsAt(row.createdAt);
      const capturedAt = (await l.flagCapturedAt(x.flagId)) ?? row.createdAt;
      const base = common(
        row,
        l,
        { action: row.action, category: x.category },
        {
          facts: {
            code: "classifier",
            category: x.category,
            tier: "t1",
            threshold: t.t1[x.category],
            capturedAt: iso(capturedAt),
          },
          source: "own_initiative",
          automatedDetection: true,
          automatedDecision: "fully",
          appeal: caseAppeal(x.caseId),
        },
      );
      return {
        kind: "statements",
        statements: [
          statement(base, {
            recipientUserId: x.userId,
            channelId: row.channelId,
            content: { type: "upload", id: x.subjectId },
            restriction: { kind: "visibility", detail: "removed", endsAt: null },
          }),
        ],
      };
    }
    case "moderation.case.warn":
    case "moderation.case.end_stream":
    case "moderation.case.suspend": {
      const x = d as SorDetails["moderation.case.warn" | "moderation.case.end_stream" | "moderation.case.suspend"];
      // The writer ends a stream only for a live broadcast case: otherwise nothing was restricted.
      if (x.decision === "end_stream" && !(d as SorDetails["moderation.case.end_stream"]).streamEnded)
        return { kind: "none", reason: "no_restriction" };
      const c = await l.moderationCase(x.caseId);
      if (!c) return { kind: "invalid", reason: "case" };
      const human = c.origin === "human";
      const reportReason = human && !c.category ? await l.reportReason(x.caseId) : null;
      const base = common(
        row,
        l,
        { action: row.action, category: c.category, reportReason },
        {
          facts: {
            code: "moderator_review",
            caseId: x.caseId,
            caseOrigin: human ? "human" : "classifier",
            decision: x.decision,
          },
          // Human-origin T1 cases are opened by user reports (`safety.report`): an Art. 16 notice.
          source: human ? "notice_art16" : "own_initiative",
          automatedDetection: !human,
          automatedDecision: "not",
          appeal: caseAppeal(x.caseId),
        },
      );
      const channelId = row.channelId ?? c.channelId;
      const subject = await caseRecipient(c, l);
      if (x.decision !== "suspend") {
        if (!subject) return { kind: "invalid", reason: "recipient" };
        return {
          kind: "statements",
          statements: [
            statement(base, {
              recipientUserId: subject,
              channelId,
              content: { type: c.subjectType, id: c.subjectId },
              restriction:
                x.decision === "warn"
                  ? { kind: "warning", detail: "none", endsAt: null }
                  : { kind: "visibility", detail: "removed", endsAt: null },
            }),
          ],
        };
      }
      const s = d as SorDetails["moderation.case.suspend"];
      const wantsUser = s.suspendTarget !== "channel" && s.userSuspended !== false;
      const wantsChannel = s.suspendTarget !== "user" && s.channelSuspended !== false;
      if (!wantsUser && !wantsChannel) return { kind: "none", reason: "no_restriction" };
      const out: Statement[] = [];
      const userTarget = wantsUser ? subject : null;
      if (userTarget)
        out.push(
          statement(base, {
            recipientUserId: userTarget,
            channelId,
            content: { type: "account", id: userTarget },
            // The account ban carries the duration (`users.ban_expires`).
            restriction: {
              kind: "account",
              detail: "suspended",
              endsAt: s.durationSeconds ? iso(new Date(row.createdAt.getTime() + s.durationSeconds * 1000)) : null,
            },
          }),
        );
      if (wantsChannel && channelId) {
        const owner = await l.channelOwner(channelId);
        // One statement per recipient (unique per audit row and recipient): when the account and
        // the channel belong to the same person only the account statement fits, so the channel
        // suspension goes unstated until the key includes the content (contract request).
        if (owner && owner !== userTarget)
          out.push(
            statement(base, {
              recipientUserId: owner,
              channelId,
              content: { type: "channel", id: channelId },
              // A moderation channel suspension has no expiry (`channels.suspended_at` only):
              // the requested duration is not an end date anything enforces.
              restriction: { kind: "service", detail: "suspended", endsAt: null },
            }),
          );
      }
      if (out.length === 0) return { kind: "invalid", reason: "recipient" };
      return { kind: "statements", statements: out };
    }
    case "ncii.decide":
    case "ncii.auto_hide": {
      const x = d as SorDetails["ncii.decide"] | SorDetails["ncii.auto_hide"];
      if ("decision" in x && x.decision !== "removed") return { kind: "none", reason: "rejected" };
      const req = await l.nciiRequest(x.requestId);
      if (!req) return { kind: "invalid", reason: "request" };
      const removal = row.action === "ncii.decide";
      const items = await l.nciiItems(x.requestId, removal ? "removed" : "hidden");
      // One statement per affected owner, naming their first item (its id is the appeal subject).
      const byOwner = new Map<string, { item: NciiItem; channelId: string }>();
      for (const item of items) {
        const owner = await l.itemOwner(item);
        if (owner && !byOwner.has(owner.ownerId)) byOwner.set(owner.ownerId, { item, channelId: owner.channelId });
      }
      // The selection only picks requests with restricted items, so no owner means the content's
      // channel no longer resolves: report it rather than drop it silently.
      if (byOwner.size === 0) return { kind: "invalid", reason: "recipient" };
      const base = common(
        row,
        l,
        { action: row.action },
        {
          // The request id and its times only: never who sent it.
          facts: {
            code: "ncii_notice",
            requestId: x.requestId,
            receivedAt: iso(req.receivedAt),
            deadlineAt: iso(req.deadlineAt),
          },
          source: "notice_art16",
          automatedDetection: false,
          // An auto-hide is decided by the deadline passing, not by a person or a model's judgment.
          automatedDecision: removal ? "not" : "fully",
          appeal: null,
        },
      );
      return {
        kind: "statements",
        statements: [...byOwner].map(([ownerId, { item, channelId }]) =>
          statement(base, {
            recipientUserId: ownerId,
            channelId,
            content: { type: item.subjectType, id: item.subjectId },
            restriction: { kind: "visibility", detail: removal ? "removed" : "disabled", endsAt: null },
            appeal: { kind: "moderation", subjectType: "ncii_request_item", subjectId: item.id },
          }),
        ),
      };
    }
    case "moderation.t0.match": {
      const x = d as SorDetails["moderation.t0.match"];
      // CSAM-list matches never produce a statement (accepted answer 1, counsel to confirm).
      if (x.listCategory !== "ncii") return { kind: "none", reason: "csam_list" };
      const capturedAt = (await l.flagCapturedAt(x.flagId)) ?? row.createdAt;
      const base = common(
        row,
        l,
        { action: row.action, listCategory: "ncii" },
        {
          // Never the distance, the provider's identifiers or the matched hash.
          facts: { code: "hash_match", listCategory: "ncii", capturedAt: iso(capturedAt) },
          source: "own_initiative",
          automatedDetection: true,
          automatedDecision: "fully",
          // The T0 case is hidden from appeals; the redress line names the contact and courts.
          appeal: null,
        },
      );
      return {
        kind: "statements",
        statements: [
          statement(base, {
            recipientUserId: x.userId,
            channelId: row.channelId,
            content: { type: x.subjectType, id: x.subjectId },
            restriction: { kind: "account", detail: "suspended", endsAt: null },
          }),
        ],
      };
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Database
 * ------------------------------------------------------------------------- */

/** The newest published document of a kind, as `legal.current` picks it (`services/api/src/lib/legal.ts`). */
export async function currentDocumentId(db: Executor, kind: "guidelines" | "enforcement_notice", now: Date) {
  const [row] = await db
    .select({ id: legalDocuments.id })
    .from(legalDocuments)
    .where(and(eq(legalDocuments.kind, kind), lte(legalDocuments.publishedAt, now)))
    .orderBy(desc(legalDocuments.publishedAt), asc(legalDocuments.isDraft), desc(legalDocuments.version))
    .limit(1);
  return row?.id ?? null;
}

/** The `moderation.thresholds` value in force at `at`, from the settings history; fail closed to the defaults. */
async function thresholdsAt(db: Executor, at: Date): Promise<Thresholds> {
  const h = governanceSettingsHistory;
  const [before] = await db
    .select({ v: h.newValue })
    .from(h)
    .where(and(eq(h.key, THRESHOLDS_KEY), lte(h.changedAt, at)))
    .orderBy(desc(h.changedAt))
    .limit(1);
  if (before) return parseThresholds(before.v).thresholds;
  const [after] = await db
    .select({ v: h.oldValue })
    .from(h)
    .where(and(eq(h.key, THRESHOLDS_KEY), gt(h.changedAt, at)))
    .orderBy(asc(h.changedAt))
    .limit(1);
  if (after && after.v !== null && after.v !== undefined) return parseThresholds(after.v).thresholds;
  const [now] = await db
    .select({ v: governanceSettings.value })
    .from(governanceSettings)
    .where(eq(governanceSettings.key, THRESHOLDS_KEY));
  return parseThresholds(now?.v).thresholds;
}

/** The database-backed lookup. */
export function dbLookup(db: Executor, documents: SorLookup["documents"]): SorLookup {
  const owners = new Map<string, string | null>();
  const channelOwner = async (channelId: string) => {
    if (!owners.has(channelId)) {
      const [c] = await db.select({ o: channels.ownerId }).from(channels).where(eq(channels.id, channelId));
      owners.set(channelId, c?.o ?? null);
    }
    return owners.get(channelId) ?? null;
  };
  return {
    documents,
    thresholdsAt: (at) => thresholdsAt(db, at),
    async moderationCase(id) {
      const [c] = await db
        .select({
          origin: moderationCases.origin,
          category: moderationCases.category,
          subjectType: moderationCases.subjectType,
          subjectId: moderationCases.subjectId,
          userId: moderationCases.userId,
          channelId: moderationCases.channelId,
        })
        .from(moderationCases)
        .where(eq(moderationCases.id, id));
      return c ?? null;
    },
    channelOwner,
    async reportReason(caseId) {
      const [r] = await db
        .select({ reason: sql<string | null>`${auditLog.details} ->> 'reason'` })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "moderation.case.report"),
            eq(auditLog.subjectType, "moderation_case"),
            eq(auditLog.subjectId, caseId),
          ),
        )
        .orderBy(asc(auditLog.createdAt))
        .limit(1);
      const reason = r?.reason;
      return reason && (REPORT_REASONS as readonly string[]).includes(reason) ? (reason as ReportReason) : null;
    },
    async flagCapturedAt(flagId) {
      const [f] = await db
        .select({ at: moderationFlags.capturedAt })
        .from(moderationFlags)
        .where(eq(moderationFlags.id, flagId));
      return f?.at ?? null;
    },
    async nciiRequest(id) {
      const [r] = await db
        .select({ receivedAt: nciiRequests.receivedAt, deadlineAt: nciiRequests.deadlineAt })
        .from(nciiRequests)
        .where(eq(nciiRequests.id, id));
      return r ?? null;
    },
    async nciiItems(requestId, which) {
      const rows = await db
        .select({
          id: nciiRequestItems.id,
          subjectType: nciiRequestItems.subjectType,
          subjectId: nciiRequestItems.subjectId,
        })
        .from(nciiRequestItems)
        .where(
          and(
            eq(nciiRequestItems.requestId, requestId),
            isNotNull(nciiRequestItems.subjectType),
            isNotNull(nciiRequestItems.subjectId),
            which === "removed" ? isNotNull(nciiRequestItems.removedAt) : isNotNull(nciiRequestItems.hiddenAt),
          ),
        )
        .orderBy(asc(nciiRequestItems.id));
      return rows.flatMap((r) =>
        r.subjectType && r.subjectId ? [{ id: r.id, subjectType: r.subjectType, subjectId: r.subjectId }] : [],
      );
    },
    async itemOwner(item) {
      let channelId: string | null = null;
      if (item.subjectType === "upload") channelId = item.subjectId; // upload items name their channel
      else if (item.subjectType === "broadcast")
        channelId =
          (await db.select({ c: broadcasts.channelId }).from(broadcasts).where(eq(broadcasts.id, item.subjectId)))[0]
            ?.c ?? null;
      else if (item.subjectType === "vod")
        channelId =
          (await db.select({ c: vods.channelId }).from(vods).where(eq(vods.id, item.subjectId)))[0]?.c ?? null;
      else if (item.subjectType === "clip")
        channelId =
          (await db.select({ c: clips.channelId }).from(clips).where(eq(clips.id, item.subjectId)))[0]?.c ?? null;
      if (!channelId) return null;
      const ownerId = await channelOwner(channelId);
      return ownerId ? { channelId, ownerId } : null;
    },
  };
}

/** The stored columns of a statement. */
export function toRow(s: Statement): typeof enforcementStatements.$inferInsert {
  return {
    id: s.id,
    sourceAuditId: s.sourceAuditId,
    sourceAction: s.sourceAction,
    recipientUserId: s.recipientUserId,
    channelId: s.channelId,
    contentType: s.content.type,
    contentId: s.content.id,
    restrictionKind: s.restriction.kind,
    restrictionDetail: s.restriction.detail,
    restrictionEndsAt: s.restriction.endsAt ? new Date(s.restriction.endsAt) : null,
    territorialScope: s.restriction.territorialScope,
    facts: s.facts,
    source: s.source,
    automatedDetection: s.automatedDetection,
    automatedDecision: s.automatedDecision,
    groundKind: s.ground.kind,
    clauseId: s.ground.clauseId,
    clauseVersion: s.ground.clauseVersion,
    legalBasis: s.ground.legalBasis,
    guidelinesDocumentId: s.documents.guidelinesId,
    noticeDocumentId: s.documents.noticeId,
    appealSubjectType: s.appeal?.subjectType ?? null,
    appealSubjectId: s.appeal?.subjectId ?? null,
    createdAt: new Date(s.createdAt),
  };
}

/**
 * A keyset position at the database's own precision: `created_at` as timestamptz text, since a
 * JS `Date` drops the microseconds `now()` stores and would re-select rows across a boundary.
 */
export interface AuditCursor {
  at: string;
  id: string;
}
export type PendingRow = AuditRow & { cursor: AuditCursor };

/** Allowlisted, expected-statement audit rows with no statement yet, oldest first, after a keyset cursor. */
export async function pendingAuditRows(
  db: Executor,
  opts: {
    limit: number;
    after?: AuditCursor;
    olderThan?: Date;
    /** Only rows written at or after this (the builder's window). */
    since?: Date;
    /** Audit ids to leave out (rows the builder already found unreadable). */
    exclude?: readonly string[];
  },
): Promise<PendingRow[]> {
  const a = auditLog;
  const rows = await db
    .select({
      id: a.id,
      action: a.action,
      channelId: a.channelId,
      details: a.details,
      createdAt: a.createdAt,
      cursorAt: sql<string>`${a.createdAt}::text`,
    })
    .from(a)
    .where(
      and(
        allowlisted(a),
        opts.since ? gte(a.createdAt, opts.since) : undefined,
        opts.olderThan ? lte(a.createdAt, opts.olderThan) : undefined,
        opts.after
          ? sql`(${a.createdAt}, ${a.id}) > (${opts.after.at}::timestamptz, ${opts.after.id}::uuid)`
          : undefined,
        opts.exclude && opts.exclude.length > 0 ? notInArray(a.id, [...opts.exclude]) : undefined,
        expectsStatement(a),
        sql`not exists (select 1 from ${enforcementStatements} s where s.source_audit_id = ${a.id})`,
      ),
    )
    .orderBy(asc(a.createdAt), asc(a.id))
    .limit(opts.limit);
  return rows.map(({ cursorAt, ...r }) => ({ ...r, cursor: { at: cursorAt, id: r.id } }));
}

/**
 * How far back each run looks. Older gaps are the coverage sweep's to report: without a bound
 * every run re-reads the whole allowlisted history, and grows with it.
 */
export const BUILD_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** How long an unreadable row is left out of runs before this process tries it again. */
export const UNREADABLE_RETRY_MS = 60 * 60_000;

/**
 * Audit ids this process found unreadable, with when it last tried them. A bad row is logged and
 * counted once per process, and left out of runs for `UNREADABLE_RETRY_MS`, so a pile of them
 * cannot keep newer rows out of a run's batches.
 */
const unreadable = new Map<string, number>();

export interface BuildResult {
  scanned: number;
  inserted: number;
  none: number;
  failures: number;
}

/**
 * One run: plan every pending row and insert its statements, each row in its own transaction
 * together with the delivery rows `sor-deliver` works from. A statement records an action that
 * is already audited, so this writes no new `audit_log` row, and no `events` row either (nothing
 * outside this job consumes statements).
 */
export async function buildStatements(
  ctx: Pick<WorkerContext, "db" | "logger" | "now">,
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<BuildResult> {
  const batch = opts.batch ?? 200;
  const maxBatches = opts.maxBatches ?? 25;
  const now = ctx.now();
  const out: BuildResult = { scanned: 0, inserted: 0, none: 0, failures: 0 };
  const [guidelinesId, noticeId] = await Promise.all([
    currentDocumentId(ctx.db, "guidelines", now),
    currentDocumentId(ctx.db, "enforcement_notice", now),
  ]);
  if (!guidelinesId || !noticeId) {
    moderationMetrics.alerts.add(1, { alert: "sor_documents_missing" });
    ctx.logger.error("statements of reasons not built: no published guidelines or enforcement notice", {
      alert: "sor_documents_missing",
      guidelines: guidelinesId !== null,
      notice: noticeId !== null,
    });
    return out;
  }
  const lookup = dbLookup(ctx.db, { guidelinesId, noticeId });
  const since = new Date(now.getTime() - BUILD_WINDOW_MS);
  const exclude = [...unreadable].flatMap(([id, at]) => (now.getTime() - at < UNREADABLE_RETRY_MS ? [id] : []));
  let after: AuditCursor | undefined;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await pendingAuditRows(ctx.db, { limit: batch, since, exclude, ...(after ? { after } : {}) });
    for (const row of rows) {
      out.scanned += 1;
      let plan: Plan;
      try {
        plan = await planStatements(row, lookup);
      } catch (err) {
        // A statement that fails the shared schema is a mapping bug: same treatment as drift.
        plan = { kind: "invalid", reason: err instanceof Error && err.name === "ZodError" ? "schema" : "error" };
      }
      if (plan.kind === "invalid") {
        out.failures += 1;
        if (!unreadable.has(row.id)) {
          moderationMetrics.sorBuildFailures.add(1, { action: row.action });
          ctx.logger.error("statement of reasons not built for an audit row", {
            alert: "sor_build_failed",
            auditId: row.id,
            action: row.action,
            reason: plan.reason,
          });
        }
        unreadable.set(row.id, now.getTime());
        continue;
      }
      unreadable.delete(row.id);
      if (plan.kind === "none") {
        out.none += 1;
        continue;
      }
      out.inserted += await insertStatements(ctx.db, plan.statements);
    }
    const last = rows.at(-1);
    if (!last || rows.length < batch) break;
    after = last.cursor;
  }
  if (out.inserted > 0) moderationMetrics.sorStatements.add(out.inserted);
  return out;
}

/** Insert statements and their pending deliveries; a rerun inserts nothing (unique per audit row and recipient). */
export async function insertStatements(db: Executor, statements: readonly Statement[]): Promise<number> {
  if (statements.length === 0) return 0;
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(enforcementStatements)
      .values(statements.map(toRow))
      .onConflictDoNothing()
      .returning({ id: enforcementStatements.id });
    if (inserted.length > 0)
      await tx
        .insert(enforcementStatementDeliveries)
        .values(
          inserted.flatMap((s) => (["in_app", "email"] as const).map((channel) => ({ statementId: s.id, channel }))),
        )
        .onConflictDoNothing();
    return inserted.length;
  });
}
