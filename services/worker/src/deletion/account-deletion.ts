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
 *
 * E6 adds, in the same transaction: outbox rows that reference the user and their webhook
 * deliveries are deleted (`scrubOutbox`), the free text they wrote in rows that are kept is
 * cleared (tip messages, report details, appeal bodies), and their data exports are deleted
 * (archives after commit). The completed notice goes to the address on file, read in the
 * transaction and never stored or logged.
 */
import { BUS, UserControlMessage } from "@commonair/contracts/events";
import { exportObjectKey } from "@commonair/contracts/internal";
import { lockLegalHold, schema, type Executor } from "@commonair/db";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import { eventNeedles, redactAnonymousTip, redactPayload, referencesUser, type DeletedIdentity } from "./references.ts";
import { moderationMetrics } from "../moderation/metrics.ts";
import { dmcaHiddenKey } from "../dmca/objects.ts";
import { thumbnailPrefix } from "../moderation/objects.ts";
import { vodObjectPrefixes } from "../vod/prefixes.ts";
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

/** Outbox rows scanned per round trip, so memory stays bounded however large the table is. */
const SCAN_BATCH = 1000;

/**
 * Outbox rows that reference the user (`referencesUser`) are deleted with their webhook
 * deliveries (delivered copies are the receivers'; ours go). Other people's rows that only
 * mention them are kept with the mentions redacted (`redactPayload`). The table is walked in
 * keyset-paginated batches, prefiltered in SQL, so only candidate payloads ever leave Postgres.
 * Anonymous tips carry no id: they are looked up through the user's tipped channels (indexed) and
 * only have their message redacted (`redactAnonymousTip`).
 * Runs last in the completion transaction, so events written by the completion itself (the
 * `stream.offline` of a channel taken off air) are scrubbed too.
 */
export async function scrubOutbox(
  tx: Executor,
  who: DeletedIdentity,
  { batch = SCAN_BATCH }: { batch?: number } = {},
): Promise<{ events: number; deliveries: number; redacted: number }> {
  const e = s.events;
  const out = { events: 0, deliveries: 0, redacted: 0 };
  const remove = async (ids: string[]) => {
    if (ids.length === 0) return;
    out.deliveries += (
      await tx
        .delete(s.webhookDeliveries)
        .where(inArray(s.webhookDeliveries.eventId, ids))
        .returning({ id: s.webhookDeliveries.id })
    ).length;
    out.events += (await tx.delete(e).where(inArray(e.id, ids)).returning({ id: e.id })).length;
  };
  const cols = { id: e.id, type: e.type, channelId: e.channelId, payload: e.payload };

  const tipped = [...new Set(who.tips.map((t) => t.channelId))];
  if (tipped.length > 0) {
    const tips = await tx
      .select(cols)
      .from(e)
      .where(
        and(
          eq(e.type, "channel.tip"),
          inArray(e.channelId, tipped),
          sql`${e.payload}->>'is_anonymous' = 'true'`,
          inArray(sql<string>`${e.payload}->>'message'`, [...new Set(who.tips.map((t) => t.message))]),
        ),
      );
    // Matched by fingerprint only (a stranger's tip can share it): the words go, the event stays.
    for (const t of tips) {
      const redacted = redactAnonymousTip(t, who);
      if (redacted === null) continue;
      await tx
        .update(e)
        .set({ payload: redacted as Record<string, unknown> })
        .where(eq(e.id, t.id));
      out.redacted++;
    }
  }

  const needles = eventNeedles(who);
  if (needles.length === 0) return out;
  const matches = or(...needles.map((n) => sql`strpos(lower(${e.payload}::text), ${n}) > 0`));
  let after: string | null = null;
  for (;;) {
    const page: { id: string; type: string; channelId: string | null; payload: Record<string, unknown> }[] = await tx
      .select(cols)
      .from(e)
      .where(after === null ? matches : and(gt(e.id, after), matches))
      .orderBy(asc(e.id))
      .limit(batch);
    if (page.length === 0) break;
    after = page[page.length - 1]?.id ?? null;
    const theirs: string[] = [];
    for (const row of page) {
      if (referencesUser(row, who)) {
        theirs.push(row.id);
        continue;
      }
      const redacted = redactPayload(row.payload, who);
      if (redacted === null) continue;
      await tx
        .update(e)
        .set({ payload: redacted as Record<string, unknown> })
        .where(eq(e.id, row.id));
      out.redacted++;
    }
    await remove(theirs);
    if (page.length < batch) break;
  }
  return out;
}

/** Where the completed notice goes: read in the transaction, never stored or logged. */
interface Notice {
  email: string;
  /** Null: not chosen; the mailer uses the instance default. */
  locale: string | null;
}

interface Completed {
  deletionId: string;
  userId: string;
  pseudonym: string;
  retained: Retained[];
  ended: EndedBroadcast | null;
  objectKeys: string[];
  objectPrefixes: string[];
  /** Export archives (deleted after commit even under a hold: they are copies, not held data). */
  exportKeys: string[];
  activeHold: boolean;
  completedAt: Date;
  notice: Notice | null;
  /** The user's OAuth apps the deletion removed (with every other user's grants of them). */
  deletedAppIds: string[];
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
    const exportKeys: string[] = [];
    const deletedAppIds: string[] = [];
    let notice: Notice | null = null;
    let identity: DeletedIdentity | null = null;
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
      // Users are pseudonymized, never deleted, so the device codes' user FK cascade never fires.
      await del(
        "oauth_device_codes",
        tx
          .delete(s.oauthDeviceCodes)
          .where(eq(s.oauthDeviceCodes.userId, userId))
          .returning({ id: s.oauthDeviceCodes.id }),
      );
      const deletedApps = await tx
        .delete(s.oauthApps)
        .where(eq(s.oauthApps.ownerId, userId))
        .returning({ id: s.oauthApps.id });
      counts.oauth_apps = deletedApps.length;
      deletedAppIds.push(...deletedApps.map((a) => a.id));
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

      // The identity as it is now, before pseudonymization below replaces it: the outbox is
      // scrubbed of it last, after every write in this transaction that can emit an event.
      const [ownChannel] = await tx
        .select({ slug: s.channels.slug })
        .from(s.channels)
        .where(eq(s.channels.ownerId, userId));
      identity = {
        id: userId,
        logins: [user.username, user.displayUsername ?? "", ownChannel?.slug ?? ""],
        email: user.email,
        tips: await tx
          .select({
            channelId: s.tips.channelId,
            amountCents: s.tips.amountCents,
            currency: s.tips.currency,
            message: s.tips.message,
          })
          .from(s.tips)
          .where(and(eq(s.tips.fromUserId, userId), ne(s.tips.message, ""))),
      };
      // Free text the user wrote in rows that are kept (the rows reference the user by id only):
      // tip messages, the details of reports they filed and the bodies of their appeals.
      await del(
        "tip_messages",
        tx
          .update(s.tips)
          .set({ message: "" })
          .where(and(eq(s.tips.fromUserId, userId), ne(s.tips.message, "")))
          .returning({ id: s.tips.id }),
      );
      await del(
        "report_details",
        tx
          .update(s.reports)
          .set({ details: "" })
          .where(and(eq(s.reports.reporterId, userId), ne(s.reports.details, "")))
          .returning({ id: s.reports.id }),
      );
      await del(
        "appeal_bodies",
        tx
          .update(s.appeals)
          .set({ body: "" })
          .where(and(eq(s.appeals.appellantId, userId), ne(s.appeals.body, "")))
          .returning({ id: s.appeals.id }),
      );
      // Data exports: rows now, archives after commit.
      const exports = await tx
        .delete(s.dataExports)
        .where(eq(s.dataExports.userId, userId))
        .returning({ id: s.dataExports.id });
      counts.data_exports = exports.length;
      exportKeys.push(...exports.map((x) => exportObjectKey(userId, x.id)));
      // An address already pseudonymized (a re-run) is not a mailbox.
      if (!user.pseudonymizedAt && !user.email.endsWith("@deleted.invalid"))
        notice = { email: user.email, locale: user.locale };

      // The user's channel: off air, content unpublished, profile pseudonymized, keys revoked.
      const [channel] = await tx.select().from(s.channels).where(eq(s.channels.ownerId, userId)).for("update");
      if (channel) {
        if (channel.liveBroadcastId) ended = await endBroadcast(tx, channel.liveBroadcastId, now);
        const vods = await tx
          .update(s.vods)
          .set({ status: "deleted", removedReason: DELETED_REASON })
          .where(and(eq(s.vods.channelId, channel.id), ne(s.vods.status, "deleted")))
          .returning({ id: s.vods.id, storagePrefix: s.vods.storagePrefix });
        const clips = await tx
          .update(s.clips)
          .set({ status: "deleted", removedReason: DELETED_REASON })
          .where(and(eq(s.clips.channelId, channel.id), ne(s.clips.status, "deleted")))
          .returning({ id: s.clips.id, storageKey: s.clips.storageKey, thumbnailKey: s.clips.thumbnailKey });
        counts.vods = vods.length;
        counts.clips = clips.length;
        // Both of a VOD's own prefixes: a placement move may have been interrupted.
        objectPrefixes.push(
          ...vods.flatMap((v) => vodObjectPrefixes(v.id, v.storagePrefix)),
          `channels/${channel.id}/`,
        );
        for (const c of clips) for (const k of [c.storageKey, c.thumbnailKey]) if (k) objectKeys.push(k);
        // DMCA-hidden copies live outside the public prefixes, whatever each row's status is now.
        const everyVod = await tx
          .select({ id: s.vods.id, storagePrefix: s.vods.storagePrefix, thumbnailKey: s.vods.thumbnailKey })
          .from(s.vods)
          .where(eq(s.vods.channelId, channel.id));
        const everyClip = await tx
          .select({ storageKey: s.clips.storageKey, thumbnailKey: s.clips.thumbnailKey })
          .from(s.clips)
          .where(eq(s.clips.channelId, channel.id));
        const everyBroadcast = await tx
          .select({ id: s.broadcasts.id })
          .from(s.broadcasts)
          .where(eq(s.broadcasts.channelId, channel.id));
        objectPrefixes.push(
          ...everyVod.flatMap((v) => vodObjectPrefixes(v.id, v.storagePrefix).map(dmcaHiddenKey)),
          ...everyBroadcast.map((b) => dmcaHiddenKey(thumbnailPrefix(b.id))),
        );
        for (const v of everyVod)
          if (v.thumbnailKey && !vodObjectPrefixes(v.id, v.storagePrefix).some((p) => v.thumbnailKey?.startsWith(p)))
            objectKeys.push(dmcaHiddenKey(v.thumbnailKey));
        for (const c of everyClip)
          for (const k of [c.storageKey, c.thumbnailKey]) if (k) objectKeys.push(dmcaHiddenKey(k));
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
        // E8: the channel bot's username is derived from the old slug, so it goes with the owner's
        // identity. Its id, role and ledger rows stay (ADR 0004). Setting pseudonymized_at is what
        // lets the app role rewrite a username (0007's identity guard).
        const [bot] = await tx
          .select({ id: s.users.id, pseudonymizedAt: s.users.pseudonymizedAt })
          .from(s.botConfigs)
          .innerJoin(s.users, eq(s.users.id, s.botConfigs.botUserId))
          .where(eq(s.botConfigs.channelId, channel.id));
        if (bot) {
          const botPseudonym = newPseudonym();
          await tx
            .update(s.users)
            .set({
              name: botPseudonym,
              username: botPseudonym,
              displayUsername: botPseudonym,
              pseudonymizedAt: bot.pseudonymizedAt ?? now,
            })
            .where(eq(s.users.id, bot.id));
          counts.channel_bot = 1;
        }
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
    if (identity) {
      const scrubbed = await scrubOutbox(tx, identity);
      counts.events = scrubbed.events;
      counts.webhook_deliveries = scrubbed.deliveries;
      counts.events_redacted = scrubbed.redacted;
    }

    const retained = await heldRows(tx, userId);
    const [activeHold] = await tx
      .select({ id: s.legalHolds.id })
      .from(s.legalHolds)
      .where(and(eq(s.legalHolds.userId, userId), isNull(s.legalHolds.releasedAt)))
      .limit(1);
    const pending =
      objectPrefixes.length + objectKeys.length + exportKeys.length > 0
        ? { mediaPrefixes: objectPrefixes, mediaKeys: objectKeys, exportKeys }
        : null;
    await tx
      .update(s.accountDeletions)
      .set({ status: "completed", completedAt: now, pseudonym, retained, pendingObjects: pending })
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
      exportKeys,
      activeHold: activeHold !== undefined,
      completedAt: now,
      notice,
      deletedAppIds,
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
  // The deleted apps' tokens and subscriptions went with them (cascade): close every chat socket
  // and EventSub session made through them, not only the deleted user's (ADR 0027).
  for (const appId of c.deletedAppIds) {
    try {
      const msg = UserControlMessage.parse({ op: "disconnect", appId, reason: "app_removed" });
      await ctx.valkey.publish(BUS.userControl, JSON.stringify(msg));
    } catch (err) {
      ctx.logger.warn("user control publish failed", { appId, errorCode: safeErrorCode(err) });
    }
  }
  if (c.notice && ctx.mailer) {
    try {
      await ctx.mailer.send(
        "accountDeletionCompleted",
        { deletedAt: c.completedAt, locale: c.notice.locale },
        c.notice.email,
      );
    } catch (err) {
      // Never the address: the deletion id is enough to find the run.
      ctx.logger.warn("account deletion: completed mail failed", {
        deletionId: c.deletionId,
        errorCode: safeErrorCode(err),
      });
    }
  }
  await purgePendingObjects(ctx, c.deletionId);
}

type PurgeOutcome = "purged" | "held" | "failed" | "none";

/**
 * Delete one completed deletion's `pending_objects`. Export archives always go (personal data,
 * never evidence). Media goes only while the user has no active legal hold, re-checked under
 * `lockLegalHold` (which placing a hold also takes); under a hold the media part stays pending
 * and is retried after release. A failure leaves everything still pending for the next run.
 */
export async function purgePendingObjects(ctx: WorkerContext, deletionId: string): Promise<PurgeOutcome> {
  const storage = ctx.storage;
  if (!storage) return "none";
  try {
    return await ctx.db.transaction(async (tx) => {
      const [d] = await tx
        .select({ userId: s.accountDeletions.userId, pending: s.accountDeletions.pendingObjects })
        .from(s.accountDeletions)
        .where(eq(s.accountDeletions.id, deletionId))
        .for("update");
      if (!d?.pending) return "none";
      const { mediaPrefixes, mediaKeys, exportKeys } = d.pending;
      for (const k of exportKeys) await storage.delete(ctx.exportsBucket, k);
      let held = false;
      if (mediaPrefixes.length + mediaKeys.length > 0) {
        await lockLegalHold(tx, d.userId);
        const [hold] = await tx
          .select({ id: s.legalHolds.id })
          .from(s.legalHolds)
          .where(and(eq(s.legalHolds.userId, d.userId), isNull(s.legalHolds.releasedAt)))
          .limit(1);
        held = hold !== undefined;
        if (!held) {
          for (const p of mediaPrefixes) await storage.deletePrefix(ctx.mediaBucket, p);
          for (const k of mediaKeys) await storage.delete(ctx.mediaBucket, k);
        }
      }
      await tx
        .update(s.accountDeletions)
        .set({ pendingObjects: held ? { mediaPrefixes, mediaKeys, exportKeys: [] } : null })
        .where(eq(s.accountDeletions.id, deletionId));
      if (held) ctx.logger.info("account deletion: media kept under legal hold", { deletionId });
      return held ? "held" : "purged";
    });
  } catch (err) {
    ctx.logger.error("account deletion: objects could not be deleted; retried next run", {
      deletionId,
      errorCode: safeErrorCode(err),
    });
    return "failed";
  }
}

/** Retry objects left by earlier completions (storage errors, or holds since released). */
async function sweepPendingObjects(ctx: WorkerContext, batch: number) {
  const rows = await ctx.db
    .select({ id: s.accountDeletions.id })
    .from(s.accountDeletions)
    .where(and(eq(s.accountDeletions.status, "completed"), isNotNull(s.accountDeletions.pendingObjects)))
    .orderBy(asc(s.accountDeletions.completedAt))
    .limit(batch);
  const counts = { objectsPurged: 0, objectsHeld: 0, objectsFailed: 0 };
  for (const r of rows) {
    const outcome = await purgePendingObjects(ctx, r.id);
    if (outcome === "purged") counts.objectsPurged++;
    else if (outcome === "held") counts.objectsHeld++;
    else if (outcome === "failed") counts.objectsFailed++;
  }
  return counts;
}

export async function runAccountDeletions(ctx: WorkerContext, batch = 20) {
  const swept = await sweepPendingObjects(ctx, batch);
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
  return { completed, failed, ...swept };
}
