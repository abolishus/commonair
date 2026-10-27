// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `appeals.*`. A member appeals a decision that concerns them; platform moderators resolve it.
 * Nobody resolves their own appeal or an appeal of their own action or decision. Resolving is one
 * transaction (the appeal row, whatever overturning undoes, the audit rows and outbox events);
 * after commit the chat/user control invalidations go out and the appellant gets the
 * `appealDecided` email.
 *
 * Subjects by kind:
 *   - `integrity`: `session` (their own playback session), `user` (their own account) or
 *     `integrity_flag` (a flag on their session, their account or their channel). An overturned
 *     appeal on these is an integrity allowance (`packages/integrity/src/allowance.ts`).
 *   - `moderation` on `moderation_action` (a `mod_actions` row that targeted them). Overturning:
 *       - channel `ban`/`timeout`: lifts the chat ban if it is still in force (`liftChatBanInTx`:
 *         `unban`/`untimeout` mod action, audit `chat.unban`/`chat.untimeout` with `appealId`,
 *         `channel.unban` event);
 *       - platform `suspend_user`/`suspend_channel`: unsuspends as `safety.suspend` does
 *         (`unsuspend_*` mod action, `user.unsuspend`/`channel.unsuspend` audit), but only a
 *         moderation suspension: a repeat-infringer (DMCA) suspension stays, and a T0 suspension
 *         refuses (FORBIDDEN, the whole resolve rolls back);
 *       - a ban or suspension that is no longer in force, or was superseded by a later action of
 *         the same kind, is left alone (`lifted: false` in the appeal's audit details);
 *       - every other action (`delete_message`, `warn`, `end_stream`, chat modes, role changes, …)
 *         is recorded only: there is nothing to undo.
 *   - `moderation` on `content_label` (a T2 mature label on a channel they own): overturning
 *     removes the label, unsets `channels.mature` if no other label is active, clears the case
 *     (audit `moderation.label.remove`, event `channel.update`). On `moderation_case` (a T1 case
 *     about them or their channel; never T0): overturning clears the case and lifts any
 *     restriction it still holds; suspensions are lifted by a moderator as usual.
 *   - `account` on `account_action` (a DMCA strike or repeat-infringer termination of theirs):
 *     overturning reverses it once (`appeal_overturned`, event `account.action.reversed`, audit
 *     `account.action.reverse`). A reversed termination lifts the repeat-infringer suspension
 *     (never a moderation or T0 one); a reversed strike leaves the content alone (the
 *     counter-notice restores it) but reverses a termination now under the threshold
 *     (`strikes_below_threshold`). An action already reversed cannot be appealed (CONFLICT).
 *   - `dmca` on `dmca_notice`: there is no appeal. The owner of removed content files a
 *     counter-notice on `/settings/copyright` (BAD_REQUEST says so); a strike is appealed as
 *     `account`.
 *
 * A subject that does not exist and one that concerns someone else look the same (NOT_FOUND),
 * so the endpoint cannot be used to probe ids.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { APPEAL_KINDS, APPEAL_SUBJECTS, APPEAL_STATUSES } from "@commonair/contracts/enums";
import {
  lockAccountActions,
  reconcileDmcaTerminationInTx,
  reverseAccountActionInTx,
  liftDmcaSuspensionInTx,
  DMCA_SUSPENSION_REASON,
  schema,
  type AccountActionRow,
} from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { publishControl, publishUserControl } from "../lib/control.ts";
import { appUrl, sendNotice } from "../mail.ts";
import { liftChatBanInTx } from "../moderation/chat-bans.ts";
import { liftRestrictionInTx } from "../moderation/restriction.ts";
import { setSuspension } from "../moderation/suspension.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull } from "../lib/dto.ts";
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";

const { appeals: appealsT, playbackSessions, integrityFlags, channels, modActions, users } = schema;
const { contentLabels, moderationCases, broadcasts, accountActions, dmcaNoticeItems } = schema;
type AppealRow = typeof appealsT.$inferSelect;
type Kind = (typeof APPEAL_KINDS)[number];
type Status = (typeof APPEAL_STATUSES)[number];
type Subject = (typeof APPEAL_SUBJECTS)[number];

/** Subject types each kind accepts. */
export const KIND_SUBJECTS: Record<Kind, readonly Subject[]> = {
  integrity: ["session", "user", "integrity_flag"],
  moderation: ["moderation_action", "content_label", "moderation_case"],
  dmca: ["dmca_notice"],
  account: ["account_action"],
};

const MINE_LIMIT = 100;
const ACCOUNT_ACTIONS_LIMIT = 100;
/** Where the appellant reads the decision (the `appealDecided` email links it). */
export const APPEALS_PATH = "/settings/appeals";
/** Where the owner of removed content files a DMCA counter-notice. */
export const COPYRIGHT_PATH = "/settings/copyright";
export const DMCA_APPEAL_MESSAGE = `Copyright removals are disputed with a counter-notice on ${COPYRIGHT_PATH}, not an appeal. A strike from the notice can be appealed as an account action.`;

/** Short reference the email quotes (the tail of the id: UUIDv7 heads are timestamps). */
export const appealRef = (id: string) => `AP-${id.replace(/-/g, "").slice(-8).toUpperCase()}`;

export const toAccountAction = (r: AccountActionRow) => ({
  id: r.id,
  action: r.action,
  sourceType: r.sourceType,
  sourceId: r.sourceId,
  createdAt: iso(r.createdAt),
  reversedAt: isoOrNull(r.reversedAt),
  reversedReason: r.reversedReason,
});

/** Mod actions whose overturn lifts something; every other action is recorded only. */
export type OverturnEffect = "chat_ban" | "suspension" | "recorded_only";
export function overturnEffectOf(action: (typeof schema.modActions.$inferSelect)["action"]): OverturnEffect {
  switch (action) {
    case "ban":
    case "timeout":
      return "chat_ban";
    case "suspend_user":
    case "suspend_channel":
      return "suspension";
    default:
      return "recorded_only";
  }
}

/** Suspension reasons an overturned moderation appeal may lift (T0 is refused by its trigger). */
const LIFTABLE_SUSPENSIONS: readonly (string | null)[] = ["moderation", "t0_hash_match"];
/** `mod_actions.reason` / audit reason of what an overturn writes (an enum-like code, no free text). */
const OVERTURN_REASON = "appeal_overturned";

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
    case "account_action": {
      const [r] = await db
        .select({ id: accountActions.id })
        .from(accountActions)
        .where(and(eq(accountActions.id, id), eq(accountActions.userId, userId)))
        .limit(1);
      return r !== undefined;
    }
    case "dmca_notice": {
      const [i] = await db
        .select({ id: dmcaNoticeItems.id })
        .from(dmcaNoticeItems)
        .where(and(eq(dmcaNoticeItems.noticeId, id), eq(dmcaNoticeItems.ownerId, userId)))
        .limit(1);
      return i !== undefined;
    }
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

/** What an overturn changed that must be published after commit. */
interface AfterCommit {
  /** A lifted chat ban: chat drops the user's cached ban (`invalidate`, scope user). */
  chatUnban: { channelId: string; userId: string } | null;
  /** A lifted platform suspension of this user: chat, IRC and EventSub drop their caches. */
  userUnsuspended: string | null;
}
type Details = Record<string, string | number | boolean | null>;
interface Overturn {
  after: AfterCommit;
  details: Details;
}
const NOTHING: AfterCommit = { chatUnban: null, userUnsuspended: null };
interface Staff {
  id: string;
  actorType: "moderator" | "admin";
}
type ModActionRow = typeof modActions.$inferSelect;

/** A later mod action of the same family against the same target (and channel) supersedes `m`. */
async function supersededBy(tx: Tx, m: ModActionRow, actions: ModActionRow["action"][]): Promise<boolean> {
  if (!m.targetUserId) return true;
  const [later] = await tx
    .select({ id: modActions.id })
    .from(modActions)
    .where(
      and(
        eq(modActions.targetUserId, m.targetUserId),
        inArray(modActions.action, actions),
        m.channelId ? eq(modActions.channelId, m.channelId) : undefined,
        ne(modActions.id, m.id),
        or(gt(modActions.createdAt, m.createdAt), and(eq(modActions.createdAt, m.createdAt), gt(modActions.id, m.id))),
      ),
    )
    .limit(1);
  return later !== undefined;
}

/** Overturned `moderation_action`: lift what is still in force (see the header comment). */
async function overturnModAction(
  tx: Tx,
  actionId: string,
  staff: Staff,
  now: Date,
  appealId: string,
): Promise<Overturn> {
  const [m] = await tx.select().from(modActions).where(eq(modActions.id, actionId));
  if (!m?.targetUserId) return { after: NOTHING, details: { effect: "recorded_only", lifted: false } };
  const effect = overturnEffectOf(m.action);
  const targetId = m.targetUserId;
  if (effect === "chat_ban") {
    // A newer ban, timeout or unban in the channel is a decision of its own, appealed on its own.
    if (!m.channelId || (await supersededBy(tx, m, ["ban", "timeout", "unban", "untimeout"])))
      return { after: NOTHING, details: { effect, lifted: false } };
    const [channel] = await tx.select().from(channels).where(eq(channels.id, m.channelId));
    const [target] = await tx
      .select({ id: users.id, username: users.username, name: users.name })
      .from(users)
      .where(eq(users.id, targetId));
    if (!channel || !target) return { after: NOTHING, details: { effect, lifted: false } };
    const lifted = await liftChatBanInTx(tx, { channel, target, actor: staff, now, appealId });
    return {
      after: lifted ? { chatUnban: { channelId: channel.id, userId: target.id }, userUnsuspended: null } : NOTHING,
      details: { effect, lifted: lifted !== null },
    };
  }
  if (effect === "suspension") {
    const kind = m.action === "suspend_user" ? "user" : "channel";
    const family: ModActionRow["action"][] =
      kind === "user" ? ["suspend_user", "unsuspend_user"] : ["suspend_channel", "unsuspend_channel"];
    if (await supersededBy(tx, { ...m, channelId: null }, family))
      return { after: NOTHING, details: { effect, lifted: false } };
    const [u] = await tx
      .select({ banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(eq(users.id, targetId));
    const [ch] = await tx
      .select({ id: channels.id, suspendedAt: channels.suspendedAt, suspendedReason: channels.suspendedReason })
      .from(channels)
      .where(m.channelId ? eq(channels.id, m.channelId) : eq(channels.ownerId, targetId));
    // Only a moderation suspension is this appeal's to lift; a repeat-infringer (DMCA) suspension
    // is appealed as an account action. T0 is attempted so that its trigger refuses (FORBIDDEN).
    const liftable =
      kind === "user"
        ? u?.banned === true && LIFTABLE_SUSPENSIONS.includes(u.banReason)
        : ch !== undefined && ch.suspendedAt !== null && LIFTABLE_SUSPENSIONS.includes(ch.suspendedReason);
    if (!liftable) return { after: NOTHING, details: { effect, lifted: false } };
    const s = await setSuspension(tx, { userId: targetId, channelId: ch?.id ?? null }, kind, false, now, undefined);
    if (!s.changed) return { after: NOTHING, details: { effect, lifted: false } };
    // The rows `safety.suspend` writes for an unsuspension.
    await tx.insert(modActions).values({
      scope: "platform",
      channelId: kind === "channel" ? (ch?.id ?? null) : null,
      moderatorId: staff.id,
      targetUserId: targetId,
      action: kind === "user" ? "unsuspend_user" : "unsuspend_channel",
      reason: OVERTURN_REASON,
      durationSeconds: null,
    });
    await audit(tx, {
      actorType: staff.actorType,
      actorId: staff.id,
      action: `${kind}.unsuspend`,
      subjectType: kind,
      subjectId: kind === "user" ? targetId : (ch?.id ?? targetId),
      channelId: ch?.id ?? null,
      reason: OVERTURN_REASON,
      details: { userId: targetId, durationSeconds: null, appealId },
    });
    return {
      after: { chatUnban: null, userUnsuspended: kind === "user" ? targetId : null },
      details: { effect, lifted: true },
    };
  }
  return { after: NOTHING, details: { effect, lifted: false } };
}

/** The `account.action.reversed` event and its audit row, for one reversal. */
async function recordReversal(tx: Tx, r: AccountActionRow, staff: Staff, appealId: string): Promise<void> {
  const reversal = r.reversedReason ?? "appeal_overturned";
  await emit(
    tx,
    "account.action.reversed",
    null,
    { account_action_id: r.id, user_id: r.userId, action: r.action, reversal },
    r.reversedAt ?? undefined,
  );
  await audit(tx, {
    actorType: staff.actorType,
    actorId: staff.id,
    action: "account.action.reverse",
    subjectType: "account_action",
    subjectId: r.id,
    details: { userId: r.userId, action: r.action, reversal, appealId },
  });
}

/** Overturned `account_action`: reverse it once, and what follows from that (header comment). */
async function overturnAccountAction(
  tx: Tx,
  actionId: string,
  userId: string,
  staff: Staff,
  now: Date,
  appealId: string,
): Promise<Overturn> {
  await lockAccountActions(tx, userId);
  const reversed = await reverseAccountActionInTx(tx, {
    id: actionId,
    now,
    byId: staff.id,
    reason: "appeal_overturned",
    appealId,
  });
  // Reversed meanwhile (a counter-notice restore): nothing left to undo.
  if (!reversed)
    return {
      after: NOTHING,
      details: { effect: "account_action", reversed: false, unsuspended: false, terminationReversed: null },
    };
  await recordReversal(tx, reversed, staff, appealId);
  let unsuspended = false;
  let terminationReversed: string | null = null;
  if (reversed.action === "dmca_termination") unsuspended = await liftDmcaSuspensionInTx(tx, userId);
  else {
    const [before] = await tx
      .select({ banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(eq(users.id, userId));
    const termination = await reconcileDmcaTerminationInTx(tx, { userId, now, byId: staff.id });
    if (termination) {
      terminationReversed = termination.id;
      await recordReversal(tx, termination, staff, appealId);
      const [after] = await tx.select({ banned: users.banned }).from(users).where(eq(users.id, userId));
      unsuspended = before?.banned === true && before.banReason === DMCA_SUSPENSION_REASON && after?.banned === false;
    }
  }
  return {
    after: { chatUnban: null, userUnsuspended: unsuspended ? userId : null },
    details: { effect: "account_action", reversed: true, unsuspended, terminationReversed },
  };
}

/** After commit: tell the appellant (a notice: a failed send never fails the resolve). */
async function emailAppellant(deps: Deps, a: AppealRow, outcome: Exclude<Status, "open">, decidedAt: Date) {
  const [u] = await deps.db
    .select({ email: users.email, locale: users.locale, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, a.appellantId));
  if (!u || u.deletedAt) return;
  await sendNotice(deps.logger, "appealDecided", () =>
    deps.mailer.send(
      "appealDecided",
      {
        appealRef: appealRef(a.id),
        kind: a.kind,
        outcome,
        decidedAt,
        decisionUrl: appUrl(deps.site, APPEALS_PATH),
        locale: u.locale,
      },
      u.email,
    ),
  );
}

export const appeals = {
  create: os.appeals.create.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    if (!KIND_SUBJECTS[input.kind].includes(input.subjectType))
      throw badRequest(`A ${input.kind} appeal cannot be about a ${input.subjectType}`);
    if (!(await subjectConcerns(deps, input.subjectType, input.subjectId, caller.user.id)))
      throw notFound("Nothing to appeal was found");
    if (input.subjectType === "dmca_notice") throw badRequest(DMCA_APPEAL_MESSAGE);
    if (input.subjectType === "account_action") {
      const [r] = await deps.db
        .select({ reversedAt: accountActions.reversedAt })
        .from(accountActions)
        .where(eq(accountActions.id, input.subjectId));
      if (r?.reversedAt) throw conflict("This decision was already reversed");
    }
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

  accountActions: os.appeals.accountActions.handler(async ({ context }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const rows = await deps.db
      .select()
      .from(accountActions)
      .where(eq(accountActions.userId, caller.user.id))
      .orderBy(desc(accountActions.createdAt), desc(accountActions.id))
      .limit(ACCOUNT_ACTIONS_LIMIT);
    return rows.map(toAccountAction);
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
    const staff: Staff = { id: caller.user.id, actorType: caller.user.role === "admin" ? "admin" : "moderator" };
    const { row, appeal, after } = await deps.db.transaction(async (tx) => {
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
      if (a.subjectType === "account_action") {
        const [r] = await tx
          .select({ actorId: accountActions.actorId })
          .from(accountActions)
          .where(eq(accountActions.id, a.subjectId));
        if (r?.actorId === caller.user.id) throw forbidden("You cannot resolve an appeal of your own decision");
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
      let overturn: Overturn = { after: NOTHING, details: {} };
      if (input.status === "overturned" && a.subjectType === "moderation_action")
        overturn = await overturnModAction(tx, a.subjectId, staff, now, a.id);
      if (input.status === "overturned" && a.subjectType === "account_action")
        overturn = await overturnAccountAction(tx, a.subjectId, a.appellantId, staff, now, a.id);
      // Ids and enums only: the appeal body and the resolution text stay on the (mutable) appeal
      // row, never in the append-only log (ADR 0004).
      await audit(tx, {
        actorType: staff.actorType,
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
          ...overturn.details,
        },
      });
      // No outbox row for the decision itself: the event catalog is EventSub's public surface and
      // appeal outcomes are private to the appellant and staff. The audit row is the record (what
      // the overturn undid writes its own events above).
      return { row: updated, appeal: a, after: overturn.after };
    });
    if (after.chatUnban)
      await publishControl(deps, after.chatUnban.channelId, {
        op: "invalidate",
        scope: "user",
        userId: after.chatUnban.userId,
      });
    if (after.userUnsuspended)
      await publishUserControl(deps, { op: "invalidate", userId: after.userUnsuspended, reason: "suspended" });
    if (row.status !== "open") await emailAppellant(deps, appeal, row.status, now);
    return toAppeal(row);
  }),
};
