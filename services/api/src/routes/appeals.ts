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
 *   - `moderation` on `content_label` (a T2 mature label on a channel they own): overturning
 *     removes the label, unsets `channels.mature` if no other label is active, clears the case
 *     (audit `moderation.label.remove`, event `channel.update`). On `moderation_case` (a T1 case
 *     about them or their channel; never T0): overturning clears the case and lifts any
 *     restriction it still holds; suspensions are lifted by a moderator as usual. The moderator
 *     who decided the case cannot resolve its appeal.
 *   - `dmca` (`dmca_notice`) and `account` (`account_action`): NOT_IMPLEMENTED. DMCA disputes go
 *     through counter-notices, and account actions have no table of their own yet.
 *
 * A subject that does not exist and one that concerns someone else look the same (NOT_FOUND),
 * so the endpoint cannot be used to probe ids.
 */
import { and, asc, desc, eq, gt, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { ORPCError } from "@orpc/server";
import type { APPEAL_KINDS, APPEAL_SUBJECTS } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { liftRestrictionInTx } from "../moderation/restriction.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";

const { appeals: appealsT, playbackSessions, integrityFlags, channels, modActions } = schema;
const { contentLabels, moderationCases, broadcasts } = schema;
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
export const UNWIRED_SUBJECTS: readonly Subject[] = ["dmca_notice", "account_action"];

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
    case "content_label": {
      const [l] = await db
        .select({ id: contentLabels.id })
        .from(contentLabels)
        .innerJoin(channels, eq(channels.id, contentLabels.channelId))
        .where(and(eq(contentLabels.id, id), eq(channels.ownerId, userId)))
        .limit(1);
      return l !== undefined;
    }
    case "moderation_case": {
      // T0 cases do not exist outside the legal role, not even to the account they concern.
      const [c] = await db
        .select({ id: moderationCases.id })
        .from(moderationCases)
        .where(
          and(
            eq(moderationCases.id, id),
            ne(moderationCases.tier, "t0"),
            or(
              eq(moderationCases.userId, userId),
              sql`exists (select 1 from ${channels} where ${channels.id} = ${moderationCases.channelId} and ${channels.ownerId} = ${userId})`,
            ),
          ),
        )
        .limit(1);
      return c !== undefined;
    }
    case "dmca_notice":
    case "account_action":
      return false;
  }
}

type Tx = Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0];

/** Overturned label appeal: one transaction (docs/testing/e4c-selectors.md "Label appeal"). */
async function removeLabel(tx: Tx, labelId: string, moderatorId: string, now: Date, appealId: string) {
  const [l] = await tx
    .update(contentLabels)
    .set({ removedAt: now, removedById: moderatorId, removedReason: "appeal_overturned" })
    .where(and(eq(contentLabels.id, labelId), isNull(contentLabels.removedAt)))
    .returning();
  if (!l) return;
  const [other] = await tx
    .select({ id: contentLabels.id })
    .from(contentLabels)
    .where(and(eq(contentLabels.channelId, l.channelId), isNull(contentLabels.removedAt)))
    .limit(1);
  let unlabelled = false;
  if (!other) {
    const [c] = await tx.update(channels).set({ mature: false }).where(eq(channels.id, l.channelId)).returning();
    if (c) {
      unlabelled = true;
      // The live broadcast took the label from the channel; it goes with it.
      if (c.liveBroadcastId)
        await tx.update(broadcasts).set({ mature: false }).where(eq(broadcasts.id, c.liveBroadcastId));
      const [cat] = c.categoryId
        ? await tx
            .select({ name: schema.categories.name })
            .from(schema.categories)
            .where(eq(schema.categories.id, c.categoryId))
        : [];
      await emit(tx, "channel.update", c.id, {
        ...broadcasterFields(c),
        title: c.title,
        language: c.language,
        category_id: c.categoryId,
        category_name: cat?.name ?? null,
        tags: c.tags,
        mature: false,
      });
    }
  }
  await tx
    .update(moderationCases)
    .set({ status: "cleared", resolution: "overturned", resolvedById: moderatorId, resolvedAt: now, updatedAt: now })
    .where(and(eq(moderationCases.id, l.caseId), ne(moderationCases.tier, "t0")));
  await audit(tx, {
    actorType: "moderator",
    actorId: moderatorId,
    action: "moderation.label.remove",
    subjectType: "content_label",
    subjectId: l.id,
    channelId: l.channelId,
    details: { labelId: l.id, caseId: l.caseId, appealId, channelUnlabelled: unlabelled },
  });
}

/** Overturned case appeal: the case is cleared and any restriction it holds is lifted. */
async function overturnCase(tx: Tx, caseId: string, moderatorId: string, now: Date, appealId: string) {
  const [c] = await tx
    .update(moderationCases)
    .set({ status: "cleared", resolution: "overturned", resolvedById: moderatorId, resolvedAt: now, updatedAt: now })
    .where(and(eq(moderationCases.id, caseId), ne(moderationCases.tier, "t0")))
    .returning();
  if (!c) return;
  const lifted = await liftRestrictionInTx(tx, c.id);
  await audit(tx, {
    actorType: "moderator",
    actorId: moderatorId,
    action: "moderation.case.overturn",
    subjectType: "moderation_case",
    subjectId: c.id,
    channelId: c.channelId,
    details: { caseId: c.id, appealId, restrictionLifted: lifted },
  });
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
      if (a.subjectType === "moderation_case") {
        const [c] = await tx
          .select({ resolvedById: moderationCases.resolvedById })
          .from(moderationCases)
          .where(eq(moderationCases.id, a.subjectId));
        if (c?.resolvedById === caller.user.id) throw forbidden("You cannot resolve an appeal of your own decision");
      }
      const [updated] = await tx
        .update(appealsT)
        .set({ status: input.status, resolution: input.resolution, resolverId: caller.user.id, resolvedAt: now })
        .where(and(eq(appealsT.id, a.id), eq(appealsT.status, "open")))
        .returning();
      if (!updated) throw conflict("This appeal is already resolved");
      if (input.status === "overturned" && a.subjectType === "content_label")
        await removeLabel(tx, a.subjectId, caller.user.id, now, a.id);
      if (input.status === "overturned" && a.subjectType === "moderation_case")
        await overturnCase(tx, a.subjectId, caller.user.id, now, a.id);
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
