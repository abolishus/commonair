// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `appeals.*`. A member appeals a decision that concerns them; platform moderators resolve it.
 *
 * Subjects by kind:
 *   - `integrity`: `session` (their own playback session), `user` (their own account) or
 *     `integrity_flag` (a flag on their session, their account or their channel). An overturned
 *     appeal on these is an integrity allowance (`packages/integrity/src/allowance.ts`).
 *   - `moderation`: `moderation_action` (a `mod_actions` row that targeted them). The moderator
 *     who took the action cannot resolve its appeal. Overturning records the decision only: it
 *     does not lift the ban or timeout (a moderator does that with the usual unban procedure).
 *   - `dmca` (`dmca_notice`) and `account` (`account_action`): NOT_IMPLEMENTED. DMCA disputes go
 *     through counter-notices, and account actions have no table of their own yet.
 *
 * A subject that does not exist and one that concerns someone else look the same (NOT_FOUND),
 * so the endpoint cannot be used to probe ids.
 */
import { and, asc, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { APPEAL_KINDS, APPEAL_SUBJECTS } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";

const { appeals: appealsT, playbackSessions, integrityFlags, channels, modActions } = schema;
type AppealRow = typeof appealsT.$inferSelect;
type Kind = (typeof APPEAL_KINDS)[number];
type Subject = (typeof APPEAL_SUBJECTS)[number];

/** Subject types each kind accepts. */
export const KIND_SUBJECTS: Record<Kind, readonly Subject[]> = {
  integrity: ["session", "user", "integrity_flag"],
  moderation: ["moderation_action", "content_label", "moderation_case"],
  dmca: ["dmca_notice"],
  account: ["account_action"],
};
/** Subject types whose decision tables are not wired to appeals yet. */
// content_label and moderation_case: wired by the E4c API unit (docs/testing/e4c-selectors.md).
export const UNWIRED_SUBJECTS: readonly Subject[] = ["dmca_notice", "account_action", "content_label", "moderation_case"];

const MINE_LIMIT = 100;

export const toAppeal = (a: AppealRow) => ({
  id: a.id,
  kind: a.kind,
  subjectType: a.subjectType,
  subjectId: a.subjectId,
  body: a.body,
  status: a.status,
  resolution: a.resolution,
  createdAt: iso(a.createdAt),
  resolvedAt: isoOrNull(a.resolvedAt),
});

/** True when the subject exists and concerns `userId`. */
async function subjectConcerns(deps: Deps, type: Subject, id: string, userId: string): Promise<boolean> {
  const db = deps.db;
  switch (type) {
    case "user":
      return id === userId;
    case "session": {
      const [s] = await db
        .select({ id: playbackSessions.id })
        .from(playbackSessions)
        .where(and(eq(playbackSessions.id, id), eq(playbackSessions.userId, userId)))
        .limit(1);
      return s !== undefined;
    }
    case "integrity_flag": {
      const [f] = await db
        .select({ id: integrityFlags.id })
        .from(integrityFlags)
        .where(
          and(
            eq(integrityFlags.id, id),
            or(
              and(eq(integrityFlags.subjectType, "user"), eq(integrityFlags.subjectId, userId)),
              and(
                eq(integrityFlags.subjectType, "session"),
                sql`exists (select 1 from ${playbackSessions} where ${playbackSessions.id} = ${integrityFlags.subjectId} and ${playbackSessions.userId} = ${userId})`,
              ),
              and(
                eq(integrityFlags.subjectType, "channel"),
                sql`exists (select 1 from ${channels} where ${channels.id} = ${integrityFlags.subjectId} and ${channels.ownerId} = ${userId})`,
              ),
            ),
          ),
        )
        .limit(1);
      return f !== undefined;
    }
    case "moderation_action": {
      const [m] = await db
        .select({ id: modActions.id })
        .from(modActions)
        .where(and(eq(modActions.id, id), eq(modActions.targetUserId, userId)))
        .limit(1);
      return m !== undefined;
    }
    case "dmca_notice":
    case "account_action":
    case "content_label":
    case "moderation_case":
      return false;
  }
}

export const appeals = {
  create: os.appeals.create.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    if (!KIND_SUBJECTS[input.kind].includes(input.subjectType))
      throw badRequest(`A ${input.kind} appeal cannot be about a ${input.subjectType}`);
    if (UNWIRED_SUBJECTS.includes(input.subjectType))
      throw new ORPCError("NOT_IMPLEMENTED", { status: 501, message: "This kind of appeal is not available yet" });
    if (!(await subjectConcerns(deps, input.subjectType, input.subjectId, caller.user.id)))
      throw notFound("Nothing to appeal was found");
    try {
      const [row] = await deps.db
        .insert(appealsT)
        .values({
          appellantId: caller.user.id,
          kind: input.kind,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          body: input.body,
          createdAt: deps.now(),
        })
        .returning();
      if (!row) throw new Error("appeal insert returned no row");
      return toAppeal(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("You already have an open appeal about this");
      throw err;
    }
  }),

  mine: os.appeals.mine.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const rows = await deps.db
      .select()
      .from(appealsT)
      .where(eq(appealsT.appellantId, caller.user.id))
      .orderBy(desc(appealsT.createdAt), desc(appealsT.id))
      .limit(MINE_LIMIT);
    return rows.map(toAppeal);
  }),

  queue: os.appeals.queue.handler(async ({ context, input }) => {
    const { deps } = context;
    const cur = decodeCursor(input.cursor, isKeyCursor);
    // Open appeals are worked oldest first; closed ones are browsed newest first.
    const oldestFirst = input.status === "open";
    let after: SQL | undefined;
    if (cur) {
      const t = new Date(cur.t);
      after = oldestFirst
        ? or(gt(appealsT.createdAt, t), and(eq(appealsT.createdAt, t), gt(appealsT.id, cur.id)))
        : or(lt(appealsT.createdAt, t), and(eq(appealsT.createdAt, t), lt(appealsT.id, cur.id)));
    }
    const rows = await deps.db
      .select()
      .from(appealsT)
      .where(and(eq(appealsT.status, input.status), after))
      .orderBy(
        ...(oldestFirst ? [asc(appealsT.createdAt), asc(appealsT.id)] : [desc(appealsT.createdAt), desc(appealsT.id)]),
      )
      .limit(input.limit + 1);
    return pageOf(rows, input.limit, toAppeal, (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }));
  }),

  resolve: os.appeals.resolve.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const now = deps.now();
    const row = await deps.db.transaction(async (tx) => {
      const [a] = await tx.select().from(appealsT).where(eq(appealsT.id, input.id)).for("update");
      if (!a) throw notFound("Appeal not found");
      if (a.status !== "open") throw conflict("This appeal is already resolved");
      if (a.appellantId === caller.user.id) throw forbidden("You cannot resolve your own appeal");
      // Nobody reviews their own decision.
      if (a.subjectType === "moderation_action") {
        const [m] = await tx
          .select({ moderatorId: modActions.moderatorId })
          .from(modActions)
          .where(eq(modActions.id, a.subjectId));
        if (m?.moderatorId === caller.user.id) throw forbidden("You cannot resolve an appeal of your own action");
      }
      const [updated] = await tx
        .update(appealsT)
        .set({ status: input.status, resolution: input.resolution, resolverId: caller.user.id, resolvedAt: now })
        .where(and(eq(appealsT.id, a.id), eq(appealsT.status, "open")))
        .returning();
      if (!updated) throw conflict("This appeal is already resolved");
      // Ids and enums only: the appeal body and the resolution text stay on the (mutable) appeal
      // row, never in the append-only log (ADR 0004).
      await audit(tx, {
        actorType: caller.user.role === "admin" ? "admin" : "moderator",
        actorId: caller.user.id,
        action: "appeal.resolve",
        subjectType: "appeal",
        subjectId: a.id,
        details: {
          kind: a.kind,
          appealSubjectType: a.subjectType,
          appealSubjectId: a.subjectId,
          appellantId: a.appellantId,
          status: input.status,
        },
      });
      // No outbox row: the event catalog is EventSub's public surface and appeal outcomes are
      // private to the appellant and staff. The audit row is the record.
      return updated;
    });
    return toAppeal(row);
  }),
};
