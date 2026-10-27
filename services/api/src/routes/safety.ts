// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `safety.*`: user reports, the report queue and its resolution, platform suspensions, the
 * audit log and the channel mod log (docs/testing/e4c-selectors.md "Reports"). DMCA procedures
 * are not part of E4c and stay unimplemented.
 *
 * - One open report per reporter and subject (serialized per pair with an advisory lock).
 * - `minor_safety` and `ncii` reports get `URGENT_REPORT_PRIORITY` and notify every `legal` user;
 *   on a broadcast, VOD or clip they also open a report-derived T1 case, which moderators can
 *   review and escalate to legal like any other case.
 * - Report details stay on the (mutable) report row; audit rows carry ids and enums only.
 */
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { REPORT_REASONS, REPORT_SUBJECTS } from "@commonair/contracts/enums";
import { MODERATION_CONSTANTS } from "@commonair/moderation";
import { schema, type Executor } from "@commonair/db";
import { audit } from "../events/audit.ts";
import { publishControl, publishUserControl } from "../lib/control.ts";
import { decodeCursor, encodeCursor, isKeyCursor, isOffsetCursor, pageOf } from "../lib/cursor.ts";
import { iso, userByUsername } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, notFound, notImplemented } from "../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { afterBroadcastEnded, endBroadcastInTx, type EndedBroadcast } from "../moderation/live.ts";
import { setSuspension } from "../moderation/suspension.ts";
import { notifyRoles } from "../moderation/notify.ts";
import { staffActorType } from "../moderation/review.ts";

const { reports, users, channels, chatMessages, vods, clips, broadcasts, moderationCases, modActions, auditLog } =
  schema;
type ReportRow = typeof reports.$inferSelect;
type ReportSubject = (typeof REPORT_SUBJECTS)[number];
type ReportReason = (typeof REPORT_REASONS)[number];

/** Reasons that outrank everything and reach the legal role at once. */
export const URGENT_REASONS: readonly ReportReason[] = ["minor_safety", "ncii"];
/** Subjects a report-derived moderation case can be about. */
const CASE_SUBJECTS = ["broadcast", "vod", "clip"] as const;

export const reportPriority = (reason: ReportReason) =>
  URGENT_REASONS.includes(reason) ? MODERATION_CONSTANTS.URGENT_REPORT_PRIORITY : 0;

/** Whether a report opens a report-derived case (urgent reasons on content subjects). */
export const opensCase = (subject: ReportSubject, reason: ReportReason): subject is (typeof CASE_SUBJECTS)[number] =>
  URGENT_REASONS.includes(reason) && (CASE_SUBJECTS as readonly string[]).includes(subject);

interface SubjectInfo {
  channelId: string | null;
  /** The account the subject belongs to (suspension target). */
  userId: string | null;
  evidence: Record<string, unknown>;
}

async function subjectInfo(db: Executor, type: ReportSubject, id: string): Promise<SubjectInfo | null> {
  switch (type) {
    case "user": {
      const [u] = await db
        .select({ id: users.id, channelId: channels.id })
        .from(users)
        .leftJoin(channels, eq(channels.ownerId, users.id))
        .where(and(eq(users.id, id), isNull(users.deletedAt)));
      return u ? { channelId: u.channelId, userId: u.id, evidence: {} } : null;
    }
    case "channel": {
      const [c] = await db
        .select({ id: channels.id, owner: channels.ownerId })
        .from(channels)
        .where(eq(channels.id, id));
      return c ? { channelId: c.id, userId: c.owner, evidence: {} } : null;
    }
    case "chat_message": {
      const [m] = await db
        .select({ channelId: chatMessages.channelId, userId: chatMessages.userId, body: chatMessages.body })
        .from(chatMessages)
        .where(eq(chatMessages.id, id));
      // The message text is kept on the report in case the message is deleted.
      return m ? { channelId: m.channelId, userId: m.userId, evidence: { body: m.body } } : null;
    }
    case "vod":
    case "clip":
    case "broadcast": {
      const t = type === "vod" ? vods : type === "clip" ? clips : broadcasts;
      const [r] = await db
        .select({ channelId: t.channelId, owner: channels.ownerId })
        .from(t)
        .innerJoin(channels, eq(channels.id, t.channelId))
        .where(eq(t.id, id));
      return r ? { channelId: r.channelId, userId: r.owner, evidence: {} } : null;
    }
  }
}

async function toReports(db: Executor, rows: ReportRow[]) {
  const ids = [...new Set(rows.map((r) => r.reporterId).filter((x): x is string => x !== null))];
  const chIds = [...new Set(rows.map((r) => r.channelId).filter((x): x is string => x !== null))];
  const [us, cs] = await Promise.all([
    ids.length ? db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids)) : [],
    chIds.length
      ? db.select({ id: channels.id, slug: channels.slug }).from(channels).where(inArray(channels.id, chIds))
      : [],
  ]);
  const u = new Map(us.map((x) => [x.id, x]));
  const c = new Map(cs.map((x) => [x.id, x.slug]));
  return rows.map((r) => ({
    id: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    channelSlug: (r.channelId && c.get(r.channelId)) || null,
    reason: r.reason,
    details: r.details,
    evidence: r.evidence,
    status: r.status,
    priority: r.priority,
    reporter: (r.reporterId && u.get(r.reporterId)) || null,
    createdAt: iso(r.createdAt),
    resolution: r.resolution,
  }));
}

export const safety = {
  report: os.safety.report.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const info = await subjectInfo(deps.db, input.subjectType, input.subjectId);
    if (!info) throw notFound("Nothing to report was found");
    const priority = reportPriority(input.reason);
    const row = await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`report:${caller.user.id}:${input.subjectType}:${input.subjectId}`}))`,
      );
      const [open] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.reporterId, caller.user.id),
            eq(reports.subjectType, input.subjectType),
            eq(reports.subjectId, input.subjectId),
            eq(reports.status, "open"),
          ),
        )
        .limit(1);
      if (open) throw conflict("You already reported this; moderators will review it");
      const [r] = await tx
        .insert(reports)
        .values({
          reporterId: caller.user.id,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          channelId: info.channelId,
          reason: input.reason,
          details: input.details,
          evidence: info.evidence,
          priority,
        })
        .returning();
      if (!r) throw new Error("report insert returned no row");
      if (opensCase(input.subjectType, input.reason)) {
        // One undecided case per subject and tier: an existing open T1 case gets the report.
        const [c] = await tx
          .insert(moderationCases)
          .values({
            tier: "t1",
            status: "open",
            origin: "human",
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            channelId: info.channelId,
            userId: info.userId,
            priority,
          })
          .onConflictDoNothing()
          .returning({ id: moderationCases.id });
        if (!c)
          // The subject already has an open T1 case: the report raises its priority.
          await tx
            .update(moderationCases)
            .set({ priority: sql`greatest(${moderationCases.priority}, ${priority})` })
            .where(
              and(
                eq(moderationCases.subjectType, input.subjectType),
                eq(moderationCases.subjectId, input.subjectId),
                eq(moderationCases.tier, "t1"),
                eq(moderationCases.status, "open"),
              ),
            );
        if (c)
          await audit(tx, {
            actorType: "user",
            actorId: caller.user.id,
            action: "moderation.case.report",
            subjectType: "moderation_case",
            subjectId: c.id,
            channelId: info.channelId,
            details: { caseId: c.id, reportId: r.id, reason: input.reason },
          });
      }
      if (priority >= MODERATION_CONSTANTS.URGENT_REPORT_PRIORITY)
        await notifyRoles(tx, ["legal"], { kind: "urgent_report", reportId: r.id, reason: input.reason });
      return r;
    });
    return { id: row.id };
  }),

  queue: os.safety.queue.handler(async ({ context, input }) => {
    const { deps } = context;
    const offset = decodeCursor(input.cursor, isOffsetCursor)?.o ?? 0;
    const rows = await deps.db
      .select()
      .from(reports)
      .where(and(eq(reports.status, input.status), input.reason ? eq(reports.reason, input.reason) : undefined))
      .orderBy(desc(reports.priority), asc(reports.createdAt), asc(reports.id))
      .limit(input.limit + 1)
      .offset(offset);
    return {
      items: await toReports(deps.db, rows.slice(0, input.limit)),
      nextCursor: rows.length > input.limit ? encodeCursor({ o: offset + input.limit }) : null,
    };
  }),

  resolve: os.safety.resolve.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    if (input.status === "dismissed" && input.action !== "none") throw badRequest("A dismissal takes no action");
    const result = await deps.db.transaction(async (tx) => {
      const [r] = await tx.select().from(reports).where(eq(reports.id, input.id)).for("update");
      if (!r) throw notFound("Report not found");
      if (r.status !== "open") throw conflict("This report is already resolved");
      const info = await subjectInfo(tx, r.subjectType, r.subjectId);
      if (info?.userId === caller.user.id) throw forbidden("You cannot resolve a report about yourself");
      let ended: EndedBroadcast | null = null;
      let suspendedUser: string | null = null;
      let chatBan: { channelId: string; userId: string } | null = null;
      switch (input.action) {
        case "none":
          break;
        case "remove_content":
          if (r.subjectType === "vod" || r.subjectType === "clip") {
            const t = r.subjectType === "vod" ? vods : clips;
            await tx
              .update(t)
              .set({ status: "deleted", removedReason: "moderation" })
              .where(and(eq(t.id, r.subjectId), sql`${t.status} <> 'deleted'`));
          } else if (r.subjectType === "chat_message")
            await tx
              .update(chatMessages)
              .set({ deletedAt: now, deletedBy: caller.user.id })
              .where(and(eq(chatMessages.id, r.subjectId), isNull(chatMessages.deletedAt)));
          else if (r.subjectType === "broadcast" && info?.channelId)
            ended = await endBroadcastInTx(tx, info.channelId, r.subjectId, now);
          else throw badRequest("Accounts and channels are suspended, not removed");
          break;
        case "suspend_user":
        case "suspend_channel": {
          if (!info?.userId) throw badRequest("The reported subject has no account");
          const kind = input.action === "suspend_user" ? "user" : "channel";
          const s = await setSuspension(
            tx,
            { userId: info.userId, channelId: info.channelId },
            kind,
            true,
            now,
            input.durationSeconds,
          );
          ended = s.ended;
          if (kind === "user" && s.changed) suspendedUser = info.userId;
          break;
        }
        case "ban_from_channel": {
          if (!info?.userId || !info.channelId || r.subjectType !== "chat_message")
            throw badRequest("Channel bans apply to chat messages");
          await tx
            .insert(schema.chatBans)
            .values({
              channelId: info.channelId,
              userId: info.userId,
              moderatorId: caller.user.id,
              reason: input.resolution,
              expiresAt: input.durationSeconds ? new Date(now.getTime() + input.durationSeconds * 1000) : null,
            })
            .onConflictDoNothing();
          chatBan = { channelId: info.channelId, userId: info.userId };
          break;
        }
      }
      const [updated] = await tx
        .update(reports)
        .set({ status: input.status, resolution: input.resolution, resolvedAt: now, assigneeId: caller.user.id })
        .where(and(eq(reports.id, r.id), eq(reports.status, "open")))
        .returning();
      if (!updated) throw conflict("This report is already resolved");
      if (input.action !== "none")
        await tx.insert(modActions).values({
          scope: input.action === "ban_from_channel" ? "channel" : "platform",
          channelId: info?.channelId ?? null,
          moderatorId: caller.user.id,
          targetUserId: info?.userId ?? null,
          action:
            input.action === "ban_from_channel"
              ? "ban"
              : input.action === "remove_content"
                ? "remove_content"
                : input.action,
          reason: input.resolution,
          durationSeconds: input.durationSeconds ?? null,
          subjectType: r.subjectType,
          subjectId: r.subjectId,
          reportId: r.id,
        });
      await audit(tx, {
        actorType: staffActorType(caller.user.role),
        actorId: caller.user.id,
        action: "report.resolve",
        subjectType: "report",
        subjectId: r.id,
        channelId: info?.channelId ?? null,
        reason: input.resolution,
        details: {
          reportId: r.id,
          status: input.status,
          action: input.action,
          reportSubjectType: r.subjectType,
          reportSubjectId: r.subjectId,
          durationSeconds: input.durationSeconds ?? null,
        },
      });
      return { updated, ended, suspendedUser, chatBan };
    });
    await afterBroadcastEnded(deps, result.ended);
    if (result.suspendedUser)
      await publishUserControl(deps, { op: "disconnect", userId: result.suspendedUser, reason: "suspended" });
    if (result.chatBan)
      await publishControl(deps, result.chatBan.channelId, {
        op: "invalidate",
        scope: "user",
        userId: result.chatBan.userId,
      });
    const [dtoRow] = await toReports(deps.db, [result.updated]);
    if (!dtoRow) throw new Error("report vanished");
    return dtoRow;
  }),

  modLog: os.safety.modLog.handler(async ({ context, input }) => {
    const { deps } = context;
    const c = requireChannel(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await deps.db
      .select()
      .from(modActions)
      .where(
        and(
          eq(modActions.channelId, c.id),
          cur
            ? or(
                lt(modActions.createdAt, new Date(cur.t)),
                and(eq(modActions.createdAt, new Date(cur.t)), lt(modActions.id, cur.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(modActions.createdAt), desc(modActions.id))
      .limit(input.limit + 1);
    const ids = [
      ...new Set(rows.flatMap((r) => [r.moderatorId, r.targetUserId]).filter((x): x is string => x !== null)),
    ];
    const people = ids.length
      ? await deps.db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids))
      : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    return pageOf(
      rows,
      input.limit,
      (r) => ({
        id: r.id,
        scope: r.scope,
        channelSlug: c.slug,
        moderator: (r.moderatorId && byId.get(r.moderatorId)) || null,
        target: (r.targetUserId && byId.get(r.targetUserId)) || null,
        action: r.action,
        reason: r.reason,
        durationSeconds: r.durationSeconds,
        createdAt: iso(r.createdAt),
      }),
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
  }),

  auditLog: os.safety.auditLog.handler(async ({ context, input }) => {
    const { deps } = context;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const where: (SQL | undefined)[] = [
      input.subjectType ? eq(auditLog.subjectType, input.subjectType) : undefined,
      input.subjectId ? eq(auditLog.subjectId, input.subjectId) : undefined,
      input.actorId ? eq(auditLog.actorId, input.actorId) : undefined,
      cur
        ? or(
            lt(auditLog.createdAt, new Date(cur.t)),
            and(eq(auditLog.createdAt, new Date(cur.t)), lt(auditLog.id, cur.id)),
          )
        : undefined,
    ];
    const rows = await deps.db
      .select()
      .from(auditLog)
      .where(and(...where))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(input.limit + 1);
    return pageOf(
      rows,
      input.limit,
      (a) => ({
        id: a.id,
        actorType: a.actorType,
        actorId: a.actorId,
        action: a.action,
        subjectType: a.subjectType,
        subjectId: a.subjectId,
        reason: a.reason,
        details: a.details,
        createdAt: iso(a.createdAt),
      }),
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
  }),

  dmca: {
    submit: os.safety.dmca.submit.handler(notImplemented),
    counter: os.safety.dmca.counter.handler(notImplemented),
    queue: os.safety.dmca.queue.handler(notImplemented),
    action: os.safety.dmca.action.handler(notImplemented),
    mine: os.safety.dmca.mine.handler(notImplemented),
    suitFiled: os.safety.dmca.suitFiled.handler(notImplemented),
  },

  suspend: os.safety.suspend.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    const target = await userByUsername(deps, input.username);
    if (!target) throw notFound("User not found");
    if (target.id === caller.user.id) throw forbidden("You cannot suspend yourself");
    if (target.role === "admin" && caller.user.role !== "admin") throw forbidden("Only admins can suspend an admin");
    const [ch] = await deps.db.select({ id: channels.id }).from(channels).where(eq(channels.ownerId, target.id));
    const result = await deps.db.transaction(async (tx) => {
      const s = await setSuspension(
        tx,
        { userId: target.id, channelId: ch?.id ?? null },
        input.target,
        input.suspended,
        now,
        input.durationSeconds,
      );
      if (s.changed) {
        await tx.insert(modActions).values({
          scope: "platform",
          channelId: input.target === "channel" ? (ch?.id ?? null) : null,
          moderatorId: caller.user.id,
          targetUserId: target.id,
          action: (input.suspended ? `suspend_${input.target}` : `unsuspend_${input.target}`) as
            | "suspend_user"
            | "suspend_channel"
            | "unsuspend_user"
            | "unsuspend_channel",
          reason: input.reason,
          durationSeconds: input.suspended ? (input.durationSeconds ?? null) : null,
        });
        await audit(tx, {
          actorType: staffActorType(caller.user.role),
          actorId: caller.user.id,
          action: `${input.target}.${input.suspended ? "suspend" : "unsuspend"}`,
          subjectType: input.target,
          subjectId: input.target === "user" ? target.id : (ch?.id ?? target.id),
          channelId: ch?.id ?? null,
          reason: input.reason,
          details: { userId: target.id, durationSeconds: input.suspended ? (input.durationSeconds ?? null) : null },
        });
      }
      return s;
    });
    await afterBroadcastEnded(deps, result.ended);
    if (result.changed && input.target === "user")
      await publishUserControl(deps, {
        op: input.suspended ? "disconnect" : "invalidate",
        userId: target.id,
        reason: "suspended",
      });
    return { ok: true as const };
  }),
};
