// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.user` and `admin.revealEmail` (overhaul wave 4, D7.5): where staff go from a report to a
 * person. T0 material is the `legal` role's alone (ADR 0006), so for everyone else the view leaves
 * out T0 cases, hash-match statements, the T0 trail in the audit log and the automatic T0 holds,
 * and never links a hold to its case. The email is never in the view: only an admin's audited
 * reveal returns it, and the audit row holds the admin's reason, never the address.
 */
import type { AdminUserView, EnforcementStatement } from "@commonair/contracts/dto";
import { schema, type Executor } from "@commonair/db";
import { and, desc, eq, inArray, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import type { Caller } from "../lib/access.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { notFound } from "../lib/errors.ts";
import { refsFor, toCase, toHold } from "../moderation/cases.ts";
import { toDeletion } from "../moderation/deletion.ts";

const { users, channels, modActions, enforcementStatements: st, reports, moderationCases, legalHolds } = schema;
const { accountDeletions, auditLog } = schema;
type UserRow = typeof users.$inferSelect;
type StatementRow = typeof st.$inferSelect;

/** At most this many statements, cases, holds and audit entries in one view. */
export const VIEW_LIMIT = 20;
/** Audit actions about T0 material (cases, evidence, NCMEC drafts, holds): legal only. */
export const T0_AUDIT_PREFIXES = ["moderation.t0.", "evidence.", "ncmec.", "legal."] as const;
/** Holds placed automatically by a T0 match or confirmation. */
const T0_HOLD_REASONS = ["csam_match", "ncii_match", "csam_confirmed"] as const;
const OPEN_CASE = ["open", "labelled", "dismissal_pending"] as const;

/** Usernames are stored lowercase; a deleted account stays findable (its deletion is part of the view). */
async function findUser(db: Executor, username: string): Promise<UserRow | null> {
  const [u] = await db.select().from(users).where(eq(users.username, username.toLowerCase())).limit(1);
  return u ?? null;
}

export function toStatement(r: StatementRow): EnforcementStatement {
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
      territorialScope: "all",
    },
    facts: r.facts,
    source: r.source,
    automatedDetection: r.automatedDetection,
    automatedDecision: r.automatedDecision,
    ground: { kind: r.groundKind, clauseId: r.clauseId, clauseVersion: r.clauseVersion, legalBasis: r.legalBasis },
    documents: { guidelinesId: r.guidelinesDocumentId, noticeId: r.noticeDocumentId },
    appeal:
      r.appealSubjectType && r.appealSubjectId
        ? {
            kind: "moderation",
            subjectType: r.appealSubjectType as NonNullable<EnforcementStatement["appeal"]>["subjectType"],
            subjectId: r.appealSubjectId,
          }
        : null,
    createdAt: iso(r.createdAt),
  };
}

export async function adminUserView(deps: Deps, caller: Caller, username: string): Promise<AdminUserView> {
  const db = deps.db;
  const now = deps.now();
  const legal = caller.user.role === "legal";
  const u = await findUser(db, username);
  if (!u) throw notFound("User not found");
  const [ch] = await db.select().from(channels).where(eq(channels.ownerId, u.id)).limit(1);
  const subjectIds = ch ? [u.id, ch.id] : [u.id];

  const caseWhere: SQL[] = [
    inArray(moderationCases.status, [...OPEN_CASE]),
    legal ? inArray(moderationCases.tier, ["t0", "t1", "t2"]) : inArray(moderationCases.tier, ["t1", "t2"]),
    ch
      ? (or(eq(moderationCases.userId, u.id), eq(moderationCases.channelId, ch.id)) ?? sql`false`)
      : eq(moderationCases.userId, u.id),
  ];
  const reportWhere = or(
    and(eq(reports.subjectType, "user"), eq(reports.subjectId, u.id)),
    ...(ch
      ? [and(eq(reports.subjectType, "channel"), eq(reports.subjectId, ch.id)), eq(reports.channelId, ch.id)]
      : []),
  );
  const auditWhere: SQL[] = [inArray(auditLog.subjectId, subjectIds)];
  if (!legal) for (const p of T0_AUDIT_PREFIXES) auditWhere.push(notLike(auditLog.action, `${p}%`));
  const holdWhere: SQL[] = [eq(legalHolds.userId, u.id)];
  if (!legal) holdWhere.push(notInArray(legalHolds.reasonCode, [...T0_HOLD_REASONS]));

  const [lastSuspend, statements, [openReports], cases, holds, [deletion], recentAudit] = await Promise.all([
    db
      .select({ createdAt: modActions.createdAt })
      .from(modActions)
      .where(and(eq(modActions.targetUserId, u.id), eq(modActions.action, "suspend_user")))
      .orderBy(desc(modActions.createdAt))
      .limit(1),
    db
      .select()
      .from(st)
      .where(and(eq(st.recipientUserId, u.id), legal ? undefined : sql`${st.facts}->>'code' <> 'hash_match'`))
      .orderBy(desc(st.createdAt), desc(st.id))
      .limit(VIEW_LIMIT),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(reports)
      .where(and(eq(reports.status, "open"), reportWhere)),
    db
      .select()
      .from(moderationCases)
      .where(and(...caseWhere))
      .orderBy(desc(moderationCases.priority), desc(moderationCases.createdAt))
      .limit(VIEW_LIMIT),
    db
      .select()
      .from(legalHolds)
      .where(and(...holdWhere))
      .orderBy(sql`${legalHolds.releasedAt} is null desc`, desc(legalHolds.createdAt))
      .limit(VIEW_LIMIT),
    db
      .select()
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, u.id))
      .orderBy(desc(accountDeletions.requestedAt))
      .limit(1),
    db
      .select()
      .from(auditLog)
      .where(and(...auditWhere))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(VIEW_LIMIT),
  ]);

  const suspensions: AdminUserView["suspensions"] = [];
  if (u.banned && (u.banExpires === null || u.banExpires > now))
    suspensions.push({
      target: "user",
      reason: u.banReason ?? "",
      since: iso(lastSuspend[0]?.createdAt ?? u.updatedAt),
      until: isoOrNull(u.banExpires),
    });
  if (ch?.suspendedAt)
    suspensions.push({ target: "channel", reason: ch.suspendedReason ?? "", since: iso(ch.suspendedAt), until: null });

  const refs = await refsFor(db, cases);
  return {
    user: {
      id: u.id,
      username: u.username,
      displayName: u.name,
      role: u.role,
      accountType: u.accountType,
      emailVerified: u.emailVerified,
      twoFactorEnabled: u.twoFactorEnabled,
      createdAt: iso(u.createdAt),
      deletedAt: isoOrNull(u.deletedAt),
    },
    channel: ch ? { id: ch.id, slug: ch.slug, displayName: ch.displayName } : null,
    suspensions,
    enforcement: statements.map(toStatement),
    openReports: Number(openReports?.n ?? 0),
    openCases: cases.map((c) => toCase(c, refs)),
    // Outside `legal`, a hold never points at its case (it may be a T0 case).
    legalHolds: holds.map((h) => (legal ? toHold(h) : { ...toHold(h), caseId: null })),
    deletion: deletion ? toDeletion(deletion) : null,
    recentAudit: recentAudit.map((a) => ({
      id: a.id,
      actorType: a.actorType,
      actorId: a.actorId,
      action: a.action,
      subjectType: a.subjectType,
      subjectId: a.subjectId,
      reason: a.reason,
      details: a.details,
      createdAt: iso(a.createdAt),
    })),
  };
}

/** The address, for an admin, with an audit row naming the reason (never the address itself). */
export async function revealEmail(
  deps: Deps,
  caller: Caller,
  input: { username: string; reason: string },
): Promise<{ email: string }> {
  const u = await findUser(deps.db, input.username);
  // A deleted account's address is gone (pseudonymized), so there is nothing to reveal.
  if (!u || u.deletedAt) throw notFound("User not found");
  await deps.db.transaction(async (tx) => {
    await audit(tx, {
      actorType: "admin",
      actorId: caller.user.id,
      action: "user.email.reveal",
      subjectType: "user",
      subjectId: u.id,
      reason: input.reason,
    });
  });
  return { email: u.email };
}
