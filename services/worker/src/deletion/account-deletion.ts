// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Account deletion (ADR 0004, e4c spec "Account deletion"): due `account_deletions` rows are
 * completed one user per transaction. Credentials, sessions, tokens, follows, notifications, chat
 * history and the rest of the user's own data are deleted; content is unpublished; the `users` and
 * `channels` rows are pseudonymized (they are referenced by id from retained records: ledger,
 * governance, audit). **Held data is never touched**: `legal_holds`, `evidence_objects`,
 * `moderation_flags`, `moderation_cases` and `ncmec_reports` stay linked by id, and `retained`
 * lists them. While the user has an active hold no media object is deleted either.
 */
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { moderationMetrics } from "../moderation/metrics.ts";
import { vodPrefix } from "../moderation/objects.ts";
import { audit, endBroadcast, safeErrorCode, type EndedBroadcast } from "../moderation/records.ts";
import { publishLiveEnded } from "../moderation/t0.ts";

const s = schema;
export const DELETED_REASON = "account_deleted";

export interface Retained {
  table: string;
  reason: string;
  rows: number;
}

/** `deleted_` + 12 hex characters: a valid, unique-enough username and channel slug. */
export const newPseudonym = () =>
  `deleted_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

/** Held tables and how to count a user's rows in each. */
export async function heldRows(tx: Executor, userId: string): Promise<Retained[]> {
  const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const n = sql<number>`count(*)::int`;
  const holds = await count(tx.select({ n }).from(s.legalHolds).where(eq(s.legalHolds.userId, userId)));
  const caseIds = (
    await tx.select({ id: s.moderationCases.id }).from(s.moderationCases).where(eq(s.moderationCases.userId, userId))
  ).map((c) => c.id);
  const holdIds = (
    await tx.select({ id: s.legalHolds.id }).from(s.legalHolds).where(eq(s.legalHolds.userId, userId))
  ).map((h) => h.id);
  const evidence =
    caseIds.length + holdIds.length === 0
      ? 0
      : await count(
          tx
            .select({ n })
            .from(s.evidenceObjects)
            .where(
              or(
                ...(caseIds.length ? [inArray(s.evidenceObjects.caseId, caseIds)] : []),
                ...(holdIds.length ? [inArray(s.evidenceObjects.holdId, holdIds)] : []),
              ),
            ),
        );
  const flags = await count(tx.select({ n }).from(s.moderationFlags).where(eq(s.moderationFlags.userId, userId)));
  const reports = await count(tx.select({ n }).from(s.ncmecReports).where(eq(s.ncmecReports.userId, userId)));
  return [
    { table: "legal_holds", reason: "legal_hold", rows: holds },
    { table: "evidence_objects", reason: "legal_hold", rows: evidence },
    { table: "moderation_flags", reason: "legal_hold", rows: flags },
    { table: "moderation_cases", reason: "legal_hold", rows: caseIds.length },
    { table: "ncmec_reports", reason: "legal_hold", rows: reports },
  ].filter((r) => r.rows > 0);
}

interface Completed {
  deletionId: string;
  userId: string;
  pseudonym: string;
  retained: Retained[];
  ended: EndedBroadcast | null;
  objectKeys: string[];
  objectPrefixes: string[];
  activeHold: boolean;
}

/** Complete one due deletion. Returns null if it is not due or someone else took it. */
export async function completeDeletion(ctx: WorkerContext, deletionId: string): Promise<Completed | null> {
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(s.accountDeletions)
      .where(
        and(
          eq(s.accountDeletions.id, deletionId),
          eq(s.accountDeletions.status, "scheduled"),
          lte(s.accountDeletions.scheduledFor, now),
        ),
      )
      .for("update", { skipLocked: true });
    if (!d) return null;
    const userId = d.userId;
    const [user] = await tx.select().from(s.users).where(eq(s.users.id, userId)).for("update");
    const pseudonym = d.pseudonym ?? newPseudonym();
    const counts: Record<string, number> = {};
    const del = async (name: string, q: Promise<unknown[]>) => {
      counts[name] = (await q).length;
    };

    let ended: EndedBroadcast | null = null;
    const objectKeys: string[] = [];
    const objectPrefixes: string[] = [];
    if (user) {
      // Credentials and sessions.
      await del(
        "sessions",
        tx.delete(s.sessions).where(eq(s.sessions.userId, userId)).returning({ id: s.sessions.id }),
      );
      await del(
        "accounts",
        tx.delete(s.accounts).where(eq(s.accounts.userId, userId)).returning({ id: s.accounts.id }),
      );
      await del(
        "two_factors",
        tx.delete(s.twoFactors).where(eq(s.twoFactors.userId, userId)).returning({ id: s.twoFactors.id }),
      );
      await del(
        "passkeys",
        tx.delete(s.passkeys).where(eq(s.passkeys.userId, userId)).returning({ id: s.passkeys.id }),
      );
      await del(
        "verifications",
        tx
          .delete(s.verifications)
          .where(sql`lower(${s.verifications.identifier}) = lower(${user.email})`)
          .returning({ id: s.verifications.id }),
      );
      await del(
        "oauth_codes",
        tx.delete(s.oauthCodes).where(eq(s.oauthCodes.userId, userId)).returning({ u: s.oauthCodes.userId }),
      );
      await del(
        "oauth_tokens",
        tx.delete(s.oauthTokens).where(eq(s.oauthTokens.userId, userId)).returning({ id: s.oauthTokens.id }),
      );
      await del(
        "event_subscriptions",
        tx
          .delete(s.eventSubscriptions)
          .where(eq(s.eventSubscriptions.userId, userId))
          .returning({ id: s.eventSubscriptions.id }),
      );
      await del(
        "oauth_apps",
        tx.delete(s.oauthApps).where(eq(s.oauthApps.ownerId, userId)).returning({ id: s.oauthApps.id }),
      );
      // Social graph and personal activity.
      const follows = await tx
        .delete(s.follows)
        .where(eq(s.follows.followerId, userId))
        .returning({ channelId: s.follows.channelId, excludedAt: s.follows.excludedAt });
      counts.follows = follows.length;
      for (const f of follows.filter((x) => x.excludedAt === null))
        await tx
          .update(s.channels)
          .set({ followerCount: sql`greatest(${s.channels.followerCount} - 1, 0)` })
          .where(eq(s.channels.id, f.channelId));
      await del(
        "channel_roles",
        tx.delete(s.channelRoles).where(eq(s.channelRoles.userId, userId)).returning({ u: s.channelRoles.userId }),
      );
      await del(
        "notifications",
        tx.delete(s.notifications).where(eq(s.notifications.userId, userId)).returning({ id: s.notifications.id }),
      );
      await del(
        "chat_messages",
        tx.delete(s.chatMessages).where(eq(s.chatMessages.userId, userId)).returning({ id: s.chatMessages.id }),
      );
      await del(
        "consent_records",
        tx.delete(s.consentRecords).where(eq(s.consentRecords.userId, userId)).returning({ id: s.consentRecords.id }),
      );
      await del(
        "song_requests",
        tx.delete(s.songRequests).where(eq(s.songRequests.requesterId, userId)).returning({ id: s.songRequests.id }),
      );
      await tx.update(s.clips).set({ creatorId: null }).where(eq(s.clips.creatorId, userId));

      // The user's channel: off air, content unpublished, profile pseudonymized, keys revoked.
      const [channel] = await tx.select().from(s.channels).where(eq(s.channels.ownerId, userId)).for("update");
      if (channel) {
        if (channel.liveBroadcastId) ended = await endBroadcast(tx, channel.liveBroadcastId, now);
        const vods = await tx
          .update(s.vods)
          .set({ status: "deleted", removedReason: DELETED_REASON })
          .where(and(eq(s.vods.channelId, channel.id), ne(s.vods.status, "deleted")))
          .returning({ id: s.vods.id });
        const clips = await tx
          .update(s.clips)
          .set({ status: "deleted", removedReason: DELETED_REASON })
          .where(and(eq(s.clips.channelId, channel.id), ne(s.clips.status, "deleted")))
          .returning({ id: s.clips.id, storageKey: s.clips.storageKey, thumbnailKey: s.clips.thumbnailKey });
        counts.vods = vods.length;
        counts.clips = clips.length;
        objectPrefixes.push(...vods.map((v) => vodPrefix(v.id)), `channels/${channel.id}/`);
        for (const c of clips) for (const k of [c.storageKey, c.thumbnailKey]) if (k) objectKeys.push(k);
        await del(
          "channel_panels",
          tx
            .delete(s.channelPanels)
            .where(eq(s.channelPanels.channelId, channel.id))
            .returning({ id: s.channelPanels.id }),
        );
        await del(
          "simulcast_targets",
          tx
            .delete(s.simulcastTargets)
            .where(eq(s.simulcastTargets.channelId, channel.id))
            .returning({ id: s.simulcastTargets.id }),
        );
        await tx
          .update(s.streamKeys)
          .set({ revokedAt: now, revokedReason: DELETED_REASON })
          .where(and(eq(s.streamKeys.channelId, channel.id), isNull(s.streamKeys.revokedAt)));
        await tx
          .update(s.channels)
          .set({ slug: pseudonym, displayName: pseudonym, title: "", description: "", theme: {}, tags: [] })
          .where(eq(s.channels.id, channel.id));
      }

      await tx
        .update(s.users)
        .set({
          name: pseudonym,
          email: `${pseudonym}@deleted.invalid`,
          emailVerified: false,
          image: null,
          username: pseudonym,
          displayUsername: null,
          birthDate: null,
          matureConfirmedAt: null,
          twoFactorEnabled: false,
          shareEmailWithFollowedChannels: false,
          pseudonymizedAt: user.pseudonymizedAt ?? now,
          deletedAt: user.deletedAt ?? now,
        })
        .where(eq(s.users.id, userId));
    }

    const retained = await heldRows(tx, userId);
    const [activeHold] = await tx
      .select({ id: s.legalHolds.id })
      .from(s.legalHolds)
      .where(and(eq(s.legalHolds.userId, userId), isNull(s.legalHolds.releasedAt)))
      .limit(1);
    await tx
      .update(s.accountDeletions)
      .set({ status: "completed", completedAt: now, pseudonym, retained })
      .where(eq(s.accountDeletions.id, d.id));
    await audit(
      tx,
      {
        action: "account.deletion.complete",
        subjectType: "user",
        subjectId: userId,
        reason: DELETED_REASON,
        details: { deletionId: d.id, userId, deleted: counts, retained, activeHold: activeHold !== undefined },
      },
      now,
    );
    return {
      deletionId: d.id,
      userId,
      pseudonym,
      retained,
      ended,
      objectKeys,
      objectPrefixes,
      activeHold: activeHold !== undefined,
    };
  });
}

/** After commit: media objects (skipped entirely under an active hold), live and user-control messages. */
async function afterCommit(ctx: WorkerContext, c: Completed) {
  if (c.ended) await publishLiveEnded(ctx, c.ended, ctx.now());
  try {
    const msg = UserControlMessage.parse({ op: "disconnect", userId: c.userId, reason: "deleted" });
    await ctx.valkey.publish(BUS.userControl, JSON.stringify(msg));
  } catch (err) {
    ctx.logger.warn("user control publish failed", { userId: c.userId, errorCode: safeErrorCode(err) });
  }
  if (c.activeHold || !ctx.storage) return;
  try {
    for (const p of c.objectPrefixes) await ctx.storage.deletePrefix(ctx.mediaBucket, p);
    for (const k of c.objectKeys) await ctx.storage.delete(ctx.mediaBucket, k);
  } catch (err) {
    // The rows are already unpublished; the objects are unreachable and retention sweeps them.
    ctx.logger.error("account deletion: media objects could not be deleted", {
      deletionId: c.deletionId,
      errorCode: safeErrorCode(err),
    });
  }
}

export async function runAccountDeletions(ctx: WorkerContext, batch = 20) {
  const due = await ctx.db
    .select({ id: s.accountDeletions.id })
    .from(s.accountDeletions)
    .where(and(eq(s.accountDeletions.status, "scheduled"), lte(s.accountDeletions.scheduledFor, ctx.now())))
    .orderBy(asc(s.accountDeletions.scheduledFor))
    .limit(batch);
  let completed = 0;
  let failed = 0;
  for (const d of due) {
    try {
      const c = await completeDeletion(ctx, d.id);
      if (!c) continue;
      completed++;
      moderationMetrics.deletions.add(1, { outcome: "completed" });
      await afterCommit(ctx, c);
      ctx.logger.info("account deletion completed", {
        deletionId: c.deletionId,
        userId: c.userId,
        retainedTables: c.retained.map((r) => r.table),
        activeHold: c.activeHold,
      });
    } catch (err) {
      failed++;
      moderationMetrics.deletions.add(1, { outcome: "failed" });
      ctx.logger.error("account deletion failed; retried next run", {
        deletionId: d.id,
        errorCode: safeErrorCode(err),
      });
    }
  }
  return { completed, failed };
}
