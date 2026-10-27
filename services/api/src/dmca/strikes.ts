// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DMCA strikes and the repeat-infringer policy (§ 512(i)(1)(A)); NOT REVIEWED BY A LAWYER. Each
 * actioned notice gives each item owner one `dmca_strike` (one per notice per owner, never per
 * URL). At `DMCA_RULES.repeatInfringerStrikes` unreversed strikes in the window, the account gets a
 * `dmca_termination` and the repeat-infringer user suspension, and platform moderators are told.
 * Counting, reversal and lifting are the shared rules in `@commonair/db` (`account-actions.ts`).
 */
import {
  activeAccountAction,
  activeDmcaStrikes,
  lockAccountActions,
  schema,
  uuidv7,
  type Executor,
} from "@commonair/db";
import { and, eq } from "drizzle-orm";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { setSuspension } from "../moderation/suspension.ts";
import { notifyRoles } from "../moderation/notify.ts";
import { repeatInfringerOutcome } from "./rules.ts";

const { accountActions, channels } = schema;

export interface StrikeActor {
  actorType: "moderator" | "admin";
  actorId: string;
}

export interface StrikeResult {
  userId: string;
  strikeId: string | null;
  /** Unreversed strikes in the window after this one. */
  strikes: number;
  terminated: boolean;
  /** The user suspension was set by this termination (false: another suspension was in force). */
  suspended: boolean;
  notified: boolean;
}

/**
 * Record this notice's strike for one owner and apply the repeat-infringer policy, inside the
 * caller's transaction. Idempotent per notice and owner: a second call records nothing.
 */
export async function strikeInTx(
  tx: Executor,
  args: { userId: string; noticeId: string; actor: StrikeActor; now: Date; threshold?: number },
): Promise<StrikeResult> {
  const { userId, noticeId, actor, now } = args;
  await lockAccountActions(tx, userId);
  const [existing] = await tx
    .select({ id: accountActions.id })
    .from(accountActions)
    .where(
      and(
        eq(accountActions.userId, userId),
        eq(accountActions.action, "dmca_strike"),
        eq(accountActions.sourceType, "dmca_notice"),
        eq(accountActions.sourceId, noticeId),
      ),
    );
  let strikeId: string | null = null;
  if (!existing) {
    strikeId = uuidv7(now.getTime());
    await tx.insert(accountActions).values({
      id: strikeId,
      userId,
      action: "dmca_strike",
      sourceType: "dmca_notice",
      sourceId: noticeId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      createdAt: now,
    });
    await emit(
      tx,
      "account.action.recorded",
      null,
      {
        account_action_id: strikeId,
        user_id: userId,
        action: "dmca_strike",
        source_type: "dmca_notice",
        source_id: noticeId,
      },
      now,
    );
  }
  const strikes = await activeDmcaStrikes(tx, userId, now);
  const active = await activeAccountAction(tx, userId, "dmca_termination");
  const outcome = strikeId === null ? "none" : repeatInfringerOutcome(strikes, active !== null, args.threshold);
  const result: StrikeResult = { userId, strikeId, strikes, terminated: false, suspended: false, notified: false };
  if (outcome === "notify") {
    await notifyRoles(tx, ["moderator", "admin"], { kind: "dmca_strike", userId, noticeId, strikes });
    result.notified = true;
  }
  if (outcome === "terminate") {
    const terminationId = uuidv7(now.getTime());
    await tx.insert(accountActions).values({
      id: terminationId,
      userId,
      action: "dmca_termination",
      sourceType: "dmca_notice",
      sourceId: noticeId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      createdAt: now,
    });
    const [ch] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.ownerId, userId));
    // Never takes over a suspension still in force (moderation, T0): the termination is recorded
    // anyway, and reversing it later can then never lift that other suspension.
    const s = await setSuspension(
      tx,
      { userId, channelId: ch?.id ?? null },
      "user",
      true,
      now,
      undefined,
      "dmca_repeat_infringer",
    );
    await emit(
      tx,
      "account.action.recorded",
      null,
      {
        account_action_id: terminationId,
        user_id: userId,
        action: "dmca_termination",
        source_type: "dmca_notice",
        source_id: noticeId,
      },
      now,
    );
    await audit(tx, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "account.dmca_termination",
      subjectType: "user",
      subjectId: userId,
      details: { userId, noticeId, accountActionId: terminationId, strikes, suspended: s.changed },
    });
    await notifyRoles(tx, ["moderator", "admin"], {
      kind: "dmca_repeat_infringer",
      userId,
      noticeId,
      strikes,
      suspended: s.changed,
    });
    Object.assign(result, { terminated: true, suspended: s.changed, notified: true });
  }
  return result;
}
