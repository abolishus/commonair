// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `moderation.*` (ADR 0006, docs/testing/e4c-selectors.md).
 *
 * - Mod queue (`safety-staff`): T1/T2 cases only. A T0 case is NOT_FOUND here, its frames are
 *   never returned, and an escalated case disappears from this queue.
 * - Legal (`legal` only; everyone else gets NOT_FOUND from the access layer): T0 cases, the
 *   two-reviewer dismissal, evidence (decrypted here and nowhere else, every view audited),
 *   NCMEC drafts and filing, holds.
 *
 * Every state change is a compare-and-set or runs on a locked row, writes its audit row and its
 * event in the same transaction, and the 0016 triggers check the same rules again.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { dto } from "@commonair/contracts";
import { MODERATION_CONSTANTS } from "@commonair/moderation";
import { schema, type Executor } from "@commonair/db";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { publishUserControl } from "../lib/control.ts";
import { decodeCursor, encodeCursor, isOffsetCursor } from "../lib/cursor.ts";
import { apiError, conflict, forbidden, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { flagsOf, historyOf, refsFor, toCase, toFlag, toHold, toLegalCase, toNcmec } from "../moderation/cases.ts";
import { openEvidence, openSnapshot } from "../moderation/evidence.ts";
import { afterBroadcastEnded, endBroadcastInTx, endLiveInTx, type EndedBroadcast } from "../moderation/live.ts";
import { notifyUser } from "../moderation/notify.ts";
import { planReview, staffActorType } from "../moderation/review.ts";
import { liftRestrictionInTx } from "../moderation/restriction.ts";
import { moderationRuntime } from "../moderation/runtime.ts";

const { moderationCases, contentLabels, users, channels, evidenceObjects, ncmecReports, legalHolds } = schema;
const { localHashList, modActions } = schema;
type CaseRow = typeof moderationCases.$inferSelect;

const offsetOf = (cursor: string | undefined) => decodeCursor(cursor, isOffsetCursor)?.o ?? 0;
function offsetPage<R, I>(rows: R[], limit: number, offset: number, map: (r: R) => I) {
  return {
    items: rows.slice(0, limit).map(map),
    nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null,
  };
}

async function lockCase(tx: Executor, id: string): Promise<CaseRow | undefined> {
  const [c] = await tx.select().from(moderationCases).where(eq(moderationCases.id, id)).for("update");
  return c;
}

/** The account a case is about: its user, else the owner of its channel. */
async function caseUserId(tx: Executor, c: CaseRow): Promise<string | null> {
  if (c.userId) return c.userId;
  if (!c.channelId) return null;
  const [ch] = await tx.select({ ownerId: channels.ownerId }).from(channels).where(eq(channels.id, c.channelId));
  return ch?.ownerId ?? null;
}

export const moderation = {
  queue: os.moderation.queue.handler(async ({ context, input }) => {
    const { deps } = context;
    const offset = offsetOf(input.cursor);
    const where: SQL[] = [
      // T0 is never in the ordinary queue.
      input.tier ? eq(moderationCases.tier, input.tier) : inArray(moderationCases.tier, ["t1", "t2"]),
      input.status ? eq(moderationCases.status, input.status) : inArray(moderationCases.status, ["open", "labelled"]),
    ];
    const rows = await deps.db
      .select()
      .from(moderationCases)
      .where(and(...where))
      .orderBy(desc(moderationCases.priority), asc(moderationCases.createdAt), asc(moderationCases.id))
      .limit(input.limit + 1)
      .offset(offset);
    const refs = await refsFor(deps.db, rows);
    return offsetPage(rows, input.limit, offset, (c) => toCase(c, refs));
  }),

  case: os.moderation.case.handler(async ({ context, input }) => {
    const { deps } = context;
    const [c] = await deps.db.select().from(moderationCases).where(eq(moderationCases.id, input.id));
    if (!c || c.tier === "t0") throw notFound("Case not found");
    const rt = await moderationRuntime(deps);
    const [refs, flags, history, labels] = await Promise.all([
      refsFor(deps.db, [c]),
      flagsOf(deps.db, c.id),
      historyOf(deps.db, c.id),
      deps.db.select().from(contentLabels).where(eq(contentLabels.caseId, c.id)).limit(1),
    ]);
    const l = labels[0];
    return {
      ...toCase(c, refs),
      flags: flags.map(toFlag),
      history,
      notScored: rt.notScored,
      label: l
        ? {
            id: l.id,
            channelId: l.channelId,
            label: l.label,
            caseId: l.caseId,
            appliedAt: l.appliedAt.toISOString(),
            removedAt: l.removedAt?.toISOString() ?? null,
          }
        : null,
    };
  }),

  frame: os.moderation.frame.handler(async ({ context, input }) => {
    const { deps } = context;
    const [row] = await deps.db
      .select({ f: schema.moderationFlags, tier: moderationCases.tier })
      .from(schema.moderationFlags)
      .innerJoin(moderationCases, eq(moderationCases.id, schema.moderationFlags.caseId))
      .where(eq(schema.moderationFlags.id, input.id));
    // T0 material never leaves through this route, whatever the flag row says.
    if (!row || row.f.tier === "t0" || row.tier === "t0" || !row.f.frameKey) throw notFound("Frame not found");
    const res = await deps.storage.get(deps.env.S3_BUCKET_MEDIA, row.f.frameKey);
    if (!res) throw notFound("Frame not found");
    return { contentType: "image/jpeg", dataBase64: Buffer.from(await res.arrayBuffer()).toString("base64") };
  }),

  review: os.moderation.review.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    const actorType = staffActorType(caller.user.role);
    const result = await deps.db.transaction(async (tx) => {
      const c = await lockCase(tx, input.id);
      if (!c) throw notFound("Case not found");
      const check = planReview(c, input.decision);
      if (!check.ok) throw apiError(check.code, check.message);
      const plan = check.plan;
      const subjectUser = await caseUserId(tx, c);
      if (subjectUser === caller.user.id) throw forbidden("You cannot review a case about yourself");

      const [updated] = await tx
        .update(moderationCases)
        .set(
          plan.escalate
            ? { tier: "t0", status: "open", origin: "human", updatedAt: now }
            : {
                status: plan.status,
                resolvedById: caller.user.id,
                resolvedAt: now,
                resolution: input.decision,
                resolutionNote: input.note,
                updatedAt: now,
              },
        )
        .where(and(eq(moderationCases.id, c.id), eq(moderationCases.status, "open")))
        .returning();
      if (!updated) throw conflict("This case is already decided");

      const lifted = plan.liftRestriction ? await liftRestrictionInTx(tx, c.id) : false;
      let ended: EndedBroadcast | null = null;
      if (plan.endStream && c.subjectType === "broadcast" && c.channelId)
        ended = await endBroadcastInTx(tx, c.channelId, c.subjectId, now);
      let suspendedUser = false;
      if (plan.suspend) {
        const target = input.suspendTarget;
        const expires = input.durationSeconds ? new Date(now.getTime() + input.durationSeconds * 1000) : null;
        if ((target === "user" || target === "both") && subjectUser) {
          // A T0 suspension is never overwritten by a shorter one.
          const rows = await tx
            .update(users)
            .set({ banned: true, banReason: "moderation", banExpires: expires })
            .where(and(eq(users.id, subjectUser), sql`not (${users.banned} and ${users.banReason} = 't0_hash_match')`))
            .returning({ id: users.id });
          suspendedUser = rows.length > 0;
          await tx.insert(modActions).values({
            scope: "platform",
            moderatorId: caller.user.id,
            targetUserId: subjectUser,
            action: "suspend_user",
            reason: input.note,
            durationSeconds: input.durationSeconds ?? null,
            subjectType: "moderation_case",
            subjectId: c.id,
          });
        }
        if ((target === "channel" || target === "both") && c.channelId) {
          await tx
            .update(channels)
            .set({ suspendedAt: now, suspendedReason: "moderation" })
            .where(and(eq(channels.id, c.channelId), isNull(channels.suspendedAt)));
          await tx.insert(modActions).values({
            scope: "platform",
            channelId: c.channelId,
            moderatorId: caller.user.id,
            targetUserId: subjectUser,
            action: "suspend_channel",
            reason: input.note,
            durationSeconds: input.durationSeconds ?? null,
            subjectType: "moderation_case",
            subjectId: c.id,
          });
          ended ??= await endLiveInTx(tx, c.channelId, now);
        }
      }
      if (input.decision === "warn" || input.decision === "end_stream")
        await tx.insert(modActions).values({
          scope: "platform",
          channelId: c.channelId,
          moderatorId: caller.user.id,
          targetUserId: subjectUser,
          action: input.decision,
          reason: input.note,
          subjectType: "moderation_case",
          subjectId: c.id,
        });
      if (plan.notifyOwner && subjectUser)
        await notifyUser(tx, subjectUser, { kind: "moderation_decision", caseId: c.id, decision: input.decision });

      await audit(tx, {
        actorType,
        actorId: caller.user.id,
        action: `moderation.case.${input.decision}`,
        subjectType: "moderation_case",
        subjectId: c.id,
        channelId: c.channelId,
        reason: input.note,
        details: {
          caseId: c.id,
          decision: input.decision,
          fromTier: c.tier,
          toTier: updated.tier,
          restrictionLifted: lifted,
          streamEnded: ended !== null,
          ...(plan.suspend
            ? { suspendTarget: input.suspendTarget, durationSeconds: input.durationSeconds ?? null }
            : {}),
        },
      });
      await emit(tx, "moderation.case.resolved", c.channelId, {
        case_id: c.id,
        tier: updated.tier,
        status: updated.status,
        resolution: input.decision,
        actor_type: caller.user.role === "legal" ? "legal" : "moderator",
      });
      return { updated, ended, suspendedUser, subjectUser };
    });
    await afterBroadcastEnded(deps, result.ended);
    if (result.suspendedUser && result.subjectUser)
      await publishUserControl(deps, { op: "disconnect", userId: result.subjectUser, reason: "suspended" });
    return toCase(result.updated, await refsFor(deps.db, [result.updated]));
  }),

  t0Queue: os.moderation.t0Queue.handler(async ({ context, input }) => {
    const { deps } = context;
    const offset = offsetOf(input.cursor);
    const rows = await deps.db
      .select()
      .from(moderationCases)
      .where(and(eq(moderationCases.tier, "t0"), input.status ? eq(moderationCases.status, input.status) : undefined))
      .orderBy(desc(moderationCases.createdAt), desc(moderationCases.id))
      .limit(input.limit + 1)
      .offset(offset);
    const items = await Promise.all(rows.slice(0, input.limit).map((c) => toLegalCase(deps.db, c)));
    return { items, nextCursor: rows.length > input.limit ? encodeCursor({ o: offset + input.limit }) : null };
  }),

  t0Confirm: os.moderation.t0Confirm.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    const rt = await moderationRuntime(deps);
    const result = await deps.db.transaction(async (tx) => {
      const c = await lockCase(tx, input.id);
      if (!c || c.tier !== "t0") throw notFound("Case not found");
      if (c.userId === caller.user.id) throw forbidden("You cannot review a case about yourself");
      // A confirmed human escalation may be confirmed again to re-send the worker job (idempotent
      // job id), so a lost enqueue never leaves a confirmed case without its T0 actions.
      if (c.status === "confirmed" && c.origin === "human") return { c, retry: true };
      if (c.status !== "open" && c.status !== "dismissal_pending") throw conflict("This case is already decided");
      const [updated] = await tx
        .update(moderationCases)
        .set({
          status: "confirmed",
          resolvedById: caller.user.id,
          resolvedAt: now,
          resolution: "confirmed",
          resolutionNote: input.note,
          updatedAt: now,
        })
        .where(and(eq(moderationCases.id, c.id), eq(moderationCases.status, c.status)))
        .returning();
      if (!updated) throw conflict("This case is already decided");
      const category = c.listCategory ?? "csam";
      const evidence = await tx
        .select({ pdq: evidenceObjects.pdq, quality: evidenceObjects.pdqQuality })
        .from(evidenceObjects)
        .where(eq(evidenceObjects.caseId, c.id));
      const hashes = [
        ...new Set(
          evidence
            .filter((e) => e.pdq && (e.quality ?? 0) >= MODERATION_CONSTANTS.PDQ_MIN_QUALITY)
            .map((e) => e.pdq as string),
        ),
      ];
      const added = hashes.length
        ? await tx
            .insert(localHashList)
            .values(
              hashes.map((pdq) => ({
                category,
                pdq,
                sourceType: "moderation_case",
                sourceId: c.id,
                addedById: caller.user.id,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: localHashList.id })
        : [];
      await audit(tx, {
        actorType: "moderator",
        actorId: caller.user.id,
        action: "moderation.t0.confirm",
        subjectType: "moderation_case",
        subjectId: c.id,
        channelId: c.channelId,
        reason: input.note,
        details: { caseId: c.id, origin: c.origin, listCategory: c.listCategory, hashesAdded: added.length },
      });
      await emit(tx, "moderation.case.resolved", c.channelId, {
        case_id: c.id,
        tier: "t0",
        status: "confirmed",
        resolution: "confirmed",
        actor_type: "legal",
      });
      return { c: updated, retry: false };
    });
    // The worker runs the full T0 actions (suspend, hide, hold, evidence, draft) for escalations.
    if (result.c.origin === "human") {
      try {
        await rt.queue.t0Escalated({ caseId: result.c.id, confirmedById: result.c.resolvedById ?? caller.user.id });
      } catch (err) {
        deps.logger.error("t0-escalated enqueue failed; confirm the case again to retry", {
          caseId: result.c.id,
          err: (err as Error).name,
        });
        throw err;
      }
    }
    return toLegalCase(deps.db, result.c);
  }),

  t0Dismiss: os.moderation.t0Dismiss.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    const result = await deps.db.transaction(async (tx) => {
      const c = await lockCase(tx, input.id);
      if (!c || c.tier !== "t0") throw notFound("Case not found");
      if (c.userId === caller.user.id) throw forbidden("You cannot review a case about yourself");
      if (c.status === "open") {
        const [updated] = await tx
          .update(moderationCases)
          .set({
            status: "dismissal_pending",
            firstReviewerId: caller.user.id,
            firstReviewedAt: now,
            firstReviewNote: input.note,
            updatedAt: now,
          })
          .where(and(eq(moderationCases.id, c.id), eq(moderationCases.status, "open")))
          .returning();
        if (!updated) throw conflict("This case changed; reload it");
        await audit(tx, {
          actorType: "moderator",
          actorId: caller.user.id,
          action: "moderation.t0.dismiss_first",
          subjectType: "moderation_case",
          subjectId: c.id,
          channelId: c.channelId,
          reason: input.note,
          details: { caseId: c.id },
        });
        return { c: updated, unsuspended: null };
      }
      if (c.status !== "dismissal_pending") throw conflict("This case is already decided");
      if (c.firstReviewerId === caller.user.id)
        throw forbidden("A second, different legal reviewer must confirm the dismissal");
      const [updated] = await tx
        .update(moderationCases)
        .set({
          status: "dismissed",
          resolvedById: caller.user.id,
          resolvedAt: now,
          resolution: "dismissed",
          resolutionNote: input.note,
          updatedAt: now,
        })
        .where(and(eq(moderationCases.id, c.id), eq(moderationCases.status, "dismissal_pending")))
        .returning();
      if (!updated) throw conflict("This case changed; reload it");
      // Lift the T0 suspension only if it is still the T0 one and no other T0 case is active
      // (the trigger refuses it otherwise). Removed media is not restored; the hold stays.
      let unsuspended = false;
      if (c.userId) {
        const [other] = await tx
          .select({ id: moderationCases.id })
          .from(moderationCases)
          .where(
            and(
              eq(moderationCases.userId, c.userId),
              eq(moderationCases.tier, "t0"),
              ne(moderationCases.id, c.id),
              inArray(moderationCases.status, ["open", "dismissal_pending", "confirmed"]),
            ),
          )
          .limit(1);
        if (!other) {
          const u = await tx
            .update(users)
            .set({ banned: false, banReason: null, banExpires: null })
            .where(and(eq(users.id, c.userId), eq(users.banned, true), eq(users.banReason, "t0_hash_match")))
            .returning({ id: users.id });
          const ch = await tx
            .update(channels)
            .set({ suspendedAt: null, suspendedReason: null })
            .where(and(eq(channels.ownerId, c.userId), eq(channels.suspendedReason, "t0_hash_match")))
            .returning({ id: channels.id });
          unsuspended = u.length > 0 || ch.length > 0;
        }
      }
      const withdrawn = await tx
        .update(ncmecReports)
        .set({
          status: "withdrawn",
          withdrawnAt: now,
          withdrawnById: caller.user.id,
          withdrawnReason: "case_dismissed",
        })
        .where(and(eq(ncmecReports.caseId, c.id), eq(ncmecReports.status, "draft")))
        .returning({ id: ncmecReports.id });
      await audit(tx, {
        actorType: "moderator",
        actorId: caller.user.id,
        action: "moderation.t0.dismiss",
        subjectType: "moderation_case",
        subjectId: c.id,
        channelId: c.channelId,
        reason: input.note,
        details: {
          caseId: c.id,
          firstReviewerId: c.firstReviewerId,
          unsuspended,
          draftWithdrawn: withdrawn.length > 0,
          mediaRestored: false,
        },
      });
      await emit(tx, "moderation.case.resolved", c.channelId, {
        case_id: c.id,
        tier: "t0",
        status: "dismissed",
        resolution: "dismissed",
        actor_type: "legal",
      });
      return { c: updated, unsuspended: unsuspended ? c.userId : null };
    });
    if (result.unsuspended)
      await publishUserControl(deps, { op: "invalidate", userId: result.unsuspended, reason: "suspended" });
    return { case: await toLegalCase(deps.db, result.c), mediaRestored: false as const };
  }),

  evidence: os.moderation.evidence.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const [e] = await deps.db.select().from(evidenceObjects).where(eq(evidenceObjects.id, input.id));
    if (!e) throw notFound("Evidence not found");
    if (e.storage !== "inline" || !e.sealed)
      throw precondition("inline_evidence", "Bucket evidence is listed by its manifest, not viewable here");
    const plain = await openEvidence(deps, e.sealed);
    // The view is recorded before a single byte is returned.
    await audit(deps.db, {
      actorType: "moderator",
      actorId: caller.user.id,
      action: "evidence.view",
      subjectType: "evidence_object",
      subjectId: e.id,
      details: { evidenceId: e.id, caseId: e.caseId, kind: e.kind },
    });
    return { id: e.id, contentType: e.contentType, dataBase64: Buffer.from(plain).toString("base64") };
  }),

  ncmecReports: os.moderation.ncmecReports.handler(async ({ context, input }) => {
    const { deps } = context;
    const offset = offsetOf(input.cursor);
    const rows = await deps.db
      .select()
      .from(ncmecReports)
      .where(input.status ? eq(ncmecReports.status, input.status) : undefined)
      .orderBy(asc(ncmecReports.createdAt), asc(ncmecReports.id))
      .limit(input.limit + 1)
      .offset(offset);
    return offsetPage(rows, input.limit, offset, toNcmec);
  }),

  ncmecReport: os.moderation.ncmecReport.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const [r] = await deps.db.select().from(ncmecReports).where(eq(ncmecReports.id, input.id));
    if (!r) throw notFound("Report not found");
    const snapshot = dto.NcmecSnapshot.parse(await openSnapshot(deps, r.snapshotSealed));
    await audit(deps.db, {
      actorType: "moderator",
      actorId: caller.user.id,
      action: "ncmec.view",
      subjectType: "ncmec_report",
      subjectId: r.id,
      details: { reportId: r.id, caseId: r.caseId },
    });
    return { ...toNcmec(r), snapshot };
  }),

  ncmecFile: os.moderation.ncmecFile.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const filedAt = new Date(input.filedAt);
    if (filedAt.getTime() > deps.now().getTime() + 5 * 60_000) throw apiError("BAD_REQUEST", "Filed in the future");
    const row = await deps.db.transaction(async (tx) => {
      const [r] = await tx.select().from(ncmecReports).where(eq(ncmecReports.id, input.id)).for("update");
      if (!r) throw notFound("Report not found");
      if (r.status !== "draft") throw conflict(`This report is already ${r.status}`);
      const [updated] = await tx
        .update(ncmecReports)
        .set({ status: "filed", externalReportId: input.externalReportId, filedAt, filedById: caller.user.id })
        .where(and(eq(ncmecReports.id, r.id), eq(ncmecReports.status, "draft")))
        .returning();
      if (!updated) throw conflict("This report changed; reload it");
      // The one-year preservation clock starts at filing (set once; the trigger enforces it).
      await tx
        .update(legalHolds)
        .set({ filedAt })
        .where(and(eq(legalHolds.id, r.holdId), isNull(legalHolds.filedAt)));
      await audit(tx, {
        actorType: "moderator",
        actorId: caller.user.id,
        action: "ncmec.filed",
        subjectType: "ncmec_report",
        subjectId: r.id,
        details: { reportId: r.id, caseId: r.caseId, holdId: r.holdId, target: r.target },
      });
      return updated;
    });
    return toNcmec(row);
  }),

  holds: os.moderation.holds.handler(async ({ context, input }) => {
    const { deps } = context;
    const offset = offsetOf(input.cursor);
    const rows = await deps.db
      .select()
      .from(legalHolds)
      .where(input.active ? isNull(legalHolds.releasedAt) : undefined)
      .orderBy(desc(legalHolds.createdAt), desc(legalHolds.id))
      .limit(input.limit + 1)
      .offset(offset);
    return offsetPage(rows, input.limit, offset, toHold);
  }),
};
